import { createHash } from "node:crypto";
import {
  accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// No hyphens within components: group-member has exactly one possible decoding.
const COMPONENT = /^[a-z0-9]{1,24}$/;
export const MAX_FRAME = 8 * 1024 * 1024;
export const roleName = (group: string, member: string) => `${group}-${member}`;
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export type Identity = { id: string; path: string };
export type Profile = {
  group: string; coordinator: string; members: string[]; suppressSelf: boolean;
  start: "now" | number; maxRows: number; maxBytes: number;
  common: string; device: string; inode: string; local: string;
  python: string; script: string; env: NodeJS.ProcessEnv;
};

export const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
}
export function integer(x: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max;
}
export function readBounded(path: string, max: number, firstLine = false): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("expected a regular file");
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      const newline = firstLine ? bytes.subarray(length, length + n).indexOf(10) : -1;
      if (newline >= 0) return bytes.subarray(0, length + newline).toString("utf8");
      length += n;
    }
    if (firstLine || length > max) throw new Error("unterminated or oversized file header");
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}
function absolute(x: unknown, name: string): string {
  if (typeof x !== "string" || !isAbsolute(x) || /[\x00-\x1f\x7f]/.test(x)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return x;
}
function executable(x: string): string {
  const path = realpathSync(x);
  if (!statSync(path).isFile()) throw new Error("not an executable file");
  accessSync(path, constants.X_OK);
  return path;
}
function directory(x: string): string {
  const path = realpathSync(x);
  if (!statSync(path).isDirectory()) throw new Error("not a directory");
  return path;
}
function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
    throw new Error("chatboard state directory must be private (0700) and owned by this user");
  }
  return realpathSync(path);
}

export function loadProfile(path: string): Profile {
  if (process.platform !== "linux") throw new Error("chatboard pilot requires Linux");
  const p = object(JSON.parse(readBounded(realpathSync(absolute(path, "PI_CHATBOARD_PROFILE")), 65536)));
  const fields = new Set(["version", "repository", "boardScript", "python", "path", "stateDir",
    "group", "coordinator", "members", "suppressSelf", "start", "maxRows", "maxBytes"]);
  if (p.version !== 1 || Object.keys(p).some(k => !fields.has(k))) throw new Error("unsupported profile field or version");
  const { group, coordinator, members } = p;
  if (typeof group !== "string" || !COMPONENT.test(group) || typeof coordinator !== "string"
    || !Array.isArray(members) || members.length < 2 || members.length > 64
    || !members.every(m => typeof m === "string" && COMPONENT.test(m))
    || new Set(members).size !== members.length || !members.includes(coordinator)) {
    throw new Error("require one group, distinct alphanumeric members, and a coordinator in members");
  }
  const start = p.start ?? "now", maxRows = p.maxRows ?? 128, maxBytes = p.maxBytes ?? 1024 * 1024;
  if ((start !== "now" && !integer(start)) || !integer(maxRows, 1, 1000)
    || !integer(maxBytes, 1024, 4 * 1024 * 1024)
    || (p.suppressSelf !== undefined && typeof p.suppressSelf !== "boolean")) throw new Error("invalid inbox policy");
  if (!Array.isArray(p.path) || !p.path.length || p.path.length > 16) throw new Error("path must list trusted directories");
  const paths = p.path.map(entry => directory(absolute(entry, "path entry")));
  if (paths.some(entry => entry.includes(":"))) throw new Error("PATH entries cannot contain ':'");
  const git = paths.flatMap(entry => {
    try { return [executable(join(entry, "git"))]; } catch { return []; }
  })[0];
  if (!git) throw new Error("git not found on profile PATH");
  const repository = directory(absolute(p.repository, "repository"));
  const python = executable(absolute(p.python, "python"));
  const script = realpathSync(absolute(p.boardScript, "boardScript"));
  if (!statSync(script).isFile()) throw new Error("boardScript is not a regular file");
  const env = {
    PATH: paths.join(":"), LC_ALL: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
  };
  const revParse = (args: string[]) => execFileSync(git, ["-C", repository, "rev-parse", ...args],
    { env, cwd: "/", timeout: 3000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trimEnd();
  const common = directory(absolute(revParse(["--path-format=absolute", "--git-common-dir"]), "Git common directory"));
  if (revParse(["--show-ref-format"]) !== "files") throw new Error("board requires Git files ref backend");
  const { dev, ino } = statSync(common, { bigint: true });
  const root = privateDirectory(absolute(p.stateDir, "stateDir"));
  // The same local user must use one state root for all profiles on this board.
  const local = privateDirectory(join(root, digest(common)));
  return { group, coordinator, members, start, maxRows, maxBytes, common, local, script, python,
    device: String(dev), inode: String(ino), env, suppressSelf: p.suppressSelf === true };
}

export function verifyBoard(p: Profile): void {
  const { dev, ino } = statSync(p.common, { bigint: true });
  if (String(dev) !== p.device || String(ino) !== p.inode) throw new Error("bound Git common directory changed");
}
export function liveIdentity(sm: ExtensionContext["sessionManager"]): Identity {
  const file = sm.getSessionFile();
  const id = sm.getSessionId();
  if (!file || !UUID.test(id) || sm.getHeader()?.id !== id) throw new Error("need an actual file-backed Pi UUID session");
  const absoluteFile = absolute(file, "Pi session file");
  const path = join(realpathSync(dirname(absoluteFile)), basename(absoluteFile));
  try {
    const header = object(JSON.parse(readBounded(path, 65536, true)));
    if (header.type !== "session" || header.id !== id) throw new Error("Pi transcript header does not match live session ID");
  } catch (e) {
    // Before a first prompt, Pi may not have written the intended file.
    if (!missing(e)) throw e;
  }
  return { id, path };
}
export function selectors(p: Profile, who: Identity, member: string): string[] {
  return [`role:${roleName(p.group, member)}`, `session:${who.id}`];
}
