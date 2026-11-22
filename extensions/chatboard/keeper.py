#!/usr/bin/env python3
"""Linux listener custody for a single live Pi enrollment (not a daemon).

The Pi stdin pipe is the lifetime lease. Keep both flocks until the owned
wait process group has been killed and its descendants reaped, even on EOF
from SIGKILL of Pi. Only the canonical, read-only board wait runs here.
"""
import ctypes
import errno
import fcntl
import json
import os
import selectors
import signal
import stat
import subprocess
import sys
import time
from contextlib import ExitStack

MAX_FRAME = 8 * 1024 * 1024
PR_SET_PDEATHSIG = 1
PR_SET_CHILD_SUBREAPER = 36
libc = ctypes.CDLL(None, use_errno=True)


def prctl(option, value):
    if libc.prctl(option, value, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def parent_death(parent):
    prctl(PR_SET_PDEATHSIG, signal.SIGKILL)
    if os.getppid() != parent:
        os._exit(125)


def emit(name, **fields):
    print(json.dumps(dict(event=name, **fields)), flush=True)


def lock(path, stack):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("invalid lock file")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


class Wait:
    def __init__(self, mux, command, fences):
        self.mux = mux
        parent = os.getpid()
        self.proc = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True, pass_fds=fences,
            env=dict(os.environ, WORK_ENGINE_REGISTRY_FENCE_FD=str(fences[0])),
            preexec_fn=lambda: parent_death(parent),
        )
        self.fd = self.proc.stdout.fileno()
        self.pidfd = None
        try:
            os.set_blocking(self.fd, False)
            self.pidfd = os.pidfd_open(self.proc.pid)
            mux.register(self.fd, selectors.EVENT_READ, "wait")
            mux.register(self.pidfd, selectors.EVENT_READ, "exit")
        except BaseException:
            self.close()
            raise
        self.remainder = bytearray()
        self.deadline = time.monotonic() + 105

    def read(self):
        try:
            chunk = os.read(self.fd, 65536)
        except BlockingIOError:
            return False
        if not chunk:
            self.unregister(self.fd)
            return False
        for part in chunk.splitlines(keepends=True):
            self.remainder.extend(part)
            if len(self.remainder) > MAX_FRAME:
                raise OverflowError
            if part.endswith(b"\n"):
                # The JS side verifies batch envelope, selectors, and cursor.
                sys.stdout.buffer.write(b'{"event":"batch","data":' + self.remainder[:-1] + b'}\n')
                sys.stdout.buffer.flush()
                self.remainder.clear()
        return True

    def unregister(self, fd):
        try:
            self.mux.unregister(fd)
        except KeyError:
            pass

    def close(self):
        # Don't reap the group leader before killpg: its PID pins the PGID.
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        while True:
            try:
                pid, status = os.waitpid(-1, 0)
            except ChildProcessError:
                break
            if pid == self.proc.pid:
                self.proc.returncode = os.waitstatus_to_exitcode(status)
        self.unregister(self.fd)
        self.proc.stdout.close()
        if self.pidfd is not None:
            self.unregister(self.pidfd)
            os.close(self.pidfd)
        return self.proc.returncode


def serve(script, common, device, inode, session, role, exclude, fences, signal_fd):
    prctl(PR_SET_CHILD_SUBREAPER, 1)
    with selectors.DefaultSelector() as mux:
        mux.register(0, selectors.EVENT_READ, "stdin")
        mux.register(signal_fd, selectors.EVENT_READ, "signal")
        emit("ready")
        wait = None
        command = bytearray()
        try:
            while True:
                events = mux.select(None if wait is None else max(0, wait.deadline - time.monotonic()))
                # Observe shutdown and parent EOF/stop before buffered rows.
                order = {"signal": 0, "stdin": 1, "wait": 2, "exit": 3}
                for key, _ in sorted(events, key=lambda event: order[event[0].data]):
                    if key.data == "signal":
                        return
                    if key.data == "stdin":
                        chunk = os.read(0, 4096)
                        if not chunk:
                            return
                        command.extend(chunk)
                        if len(command) > 4096:
                            raise ValueError("oversized keeper control")
                        while b"\n" in command:
                            line, _, command = command.partition(b"\n")
                            if line == b"stop":
                                if wait is not None:
                                    wait.close()
                                    wait = None
                                emit("ended", stopped=True)
                            elif line.startswith(b"start ") and line[6:].isdigit() and len(line) <= 22 and wait is None:
                                info = os.stat(common)
                                if (str(info.st_dev), str(info.st_ino)) != (device, inode):
                                    raise ValueError("board identity changed")
                                argv = [sys.executable, "-I", "-B", script, "--repository", common,
                                        "wait", "--follow", "--since", line[6:].decode("ascii"), "--limit", "1",
                                        "--timeout-seconds", "75", "--topic", role, "--topic", session]
                                if exclude != "-":
                                    argv += ["--exclude-session-id", exclude]
                                wait = Wait(mux, argv, fences)
                                emit("started", pid=wait.proc.pid)
                            else:
                                raise ValueError("invalid keeper control")
                        # A stop/start can replace the ready descriptors in this select result.
                        break
                    if wait is None:
                        break
                    try:
                        if key.data == "exit":
                            while wait.read():
                                pass
                            partial = bool(wait.remainder)
                            code = wait.close()
                            wait = None
                            emit("ended", code=code, partial=partial)
                            break
                        wait.read()
                    except OverflowError:
                        wait.close()
                        wait = None
                        emit("oversize")
                        break
                if wait is not None and time.monotonic() >= wait.deadline:
                    wait.close()
                    wait = None
                    emit("ended", deadline=True)
        finally:
            if wait is not None:
                wait.close()


def main():
    local, session_hash, member_hash, script, common, device, inode, session, role, exclude = sys.argv[1:]
    with ExitStack() as stack:
        signal_fd, wake_fd = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
        stack.callback(os.close, signal_fd)
        stack.callback(os.close, wake_fd)
        stack.callback(signal.set_wakeup_fd, signal.set_wakeup_fd(wake_fd))
        try:
            fences = tuple(lock(os.path.join(local, f"{name}.lock"), stack)
                           for name in (f"session-{session_hash}", f"member-{member_hash}"))
        except OSError as e:
            if e.errno not in (errno.EAGAIN, errno.EACCES):
                raise
            emit("busy")
            return
        serve(script, common, device, inode, session, role, exclude, fences, signal_fd)


def finish(_signum, _frame):
    # Wake the selector without raising between spawn and adoption, or during reap.
    pass


if __name__ == "__main__":
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, finish)
    try:
        main()
    except BrokenPipeError:
        # Pi is gone; the wait group has been reaped by serve's finally block.
        sys.stdout = open(os.devnull, "w")
    except (OSError, ValueError, subprocess.SubprocessError):
        try:
            emit("fault")
        except BrokenPipeError:
            sys.stdout = open(os.devnull, "w")
        raise SystemExit(1) from None
