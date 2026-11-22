import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest, integer, MAX_FRAME, object, selectors, verifyBoard, type Identity, type Profile } from "./bindings.ts";
import { boardCall, boardTail, decodeBatch } from "./board.ts";
import { Publisher, type Send, type Tell } from "./publish.ts";
import { Store, type Membership, type WakeRequest } from "./store.ts";

type WakeHost = {
  ready(): boolean;
  submit(request: WakeRequest, coordinator: boolean): void;
  receipts(): string[];
};

type Keeper = ChildProcessWithoutNullStreams;
const keeperPath = fileURLToPath(new URL("./keeper.py", import.meta.url));

// Never decode a partial UTF-8 frame and never let a malformed source grow the buffer unboundedly.
class Lines {
  private pieces: Buffer[] = [];
  private bytes = 0;
  push(chunk: Buffer, frame: (line: string) => void): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      this.bytes += part.length;
      if (this.bytes > MAX_FRAME + 64) throw new Error("oversized keeper frame");
      if (part.length) this.pieces.push(part);
      if (end < 0) return;
      const line = Buffer.concat(this.pieces, this.bytes).toString("utf8");
      this.pieces = [];
      this.bytes = 0;
      frame(line);
      start = end + 1;
    }
  }
}

export class Runtime {
  private store: Store;
  private child?: Keeper;
  private closedChild?: Promise<void>;
  private owner?: Membership;
  private publisher?: Publisher;
  private member?: string;
  private topics: string[] = [];
  private exclude: string | null;
  private state: "off" | "connecting" | "listening" | "retrying" | "paused" | "unavailable" = "off";
  private wait: "idle" | "requested" | "running" | "stopping" = "idle";
  private cursor?: number;
  private pid?: number;
  private timer?: NodeJS.Timeout;
  private wakeTimer?: NodeJS.Timeout;
  private wakeRequest?: { id: string; at: number };
  private wakeIssue?: string;
  private failures = 0;
  private blocked?: { reason: string; oversize: boolean };
  private reason?: string;
  private fatal = false;
  private retired = false;
  private lastStatus = "";
  private closing?: Promise<void>;
  private joining?: { resolve(): void; reject(error: Error): void };
  private sends = new Set<Promise<unknown>>();

  private p: Profile;
  private who: Identity;
  private display: (text?: string) => void;
  constructor(p: Profile, who: Identity, display: (text?: string) => void, private wakeHost: WakeHost) {
    this.p = p;
    this.who = who;
    this.display = display;
    this.store = new Store(p);
    this.exclude = p.suppressSelf ? who.id : null;
  }

  start(request: string | undefined) {
    const known = this.store.bySession(this.who.id);
    if (known && (known.namespace !== this.p.group || known.transcript !== this.who.path
      || (request !== undefined && known.member !== request))) {
      throw new Error("session is already associated with another membership or transcript");
    }
    const member = known?.member ?? request;
    if (member === undefined) { this.render(); return; }
    this.listen(member);
  }

  assertUnassigned() {
    if (this.member || this.store.bySession(this.who.id)) throw new Error("session is already assigned or joining");
    if (this.retired || this.fatal) throw new Error("chatboard runtime is unavailable");
  }

  join(member: string): Promise<void> {
    this.assertUnassigned();
    if (!this.p.members.includes(member)) throw new Error("requested member is not in this group");
    if (this.store.byMember(member)) throw new Error("member already enrolled; stopping a session does not release its association");
    return new Promise((resolve, reject) => {
      this.joining = { resolve, reject };
      try { this.listen(member); }
      catch (e) { this.rejectJoin(e as Error); }
    });
  }

  private listen(member: string) {
    if (!this.p.members.includes(member)) throw new Error("requested member is not in this group");
    this.member = member;
    this.topics = selectors(this.p, this.who, member);
    this.connect();
    this.wakeTimer = setInterval(() => this.pumpWakes(), 400).unref();
  }

  private rejectJoin(error: Error) {
    const joining = this.joining;
    this.joining = undefined;
    this.member = this.reason = undefined;
    this.topics = [];
    clearInterval(this.wakeTimer);
    this.wakeTimer = undefined;
    this.state = "off";
    joining?.reject(error);
    if (!this.retired) this.render();
  }

  private connect() {
    if (this.child || this.retired || this.fatal || !this.member) return;
    this.state = "connecting";
    this.render();
    const p = this.p;
    const child = spawn(p.python, ["-I", "-B", keeperPath, p.local, digest(this.who.id),
      digest(JSON.stringify([p.group, this.member])), p.script, p.common, p.device, p.inode,
      this.topics[1], this.topics[0], this.exclude ?? "-"],
    { cwd: "/", env: p.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.closedChild = new Promise(resolve => child.once("close", () => resolve()));
    const lines = new Lines();
    const disconnect = (reason: string) => {
      if (this.child !== child || this.retired) return;
      this.reason = reason;
      this.state = "retrying";
      child.stdin.destroy();
      this.render();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child || this.retired || this.fatal || child.stdin.destroyed) return;
      try { lines.push(chunk, line => this.event(child, object(JSON.parse(line)))); }
      catch { disconnect("invalid listener protocol; replaying from committed cursor"); }
    });
    child.stderr.resume(); // Don't reveal raw command args or row data in Pi logs.
    child.stdin.on("error", () => disconnect("listener lease pipe closed"));
    child.on("error", () => disconnect("could not start listener keeper"));
    child.once("close", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.owner = undefined;
      this.publisher = undefined;
      this.pid = undefined;
      this.wait = "idle";
      if (this.joining) {
        this.rejectJoin(new Error(this.retired ? "session closed during join" : this.reason ?? "listener keeper stopped before enrollment"));
        return;
      }
      if (this.retired || this.fatal) return;
      this.schedule("keeper stopped; reconnecting", () => this.connect());
    });
  }

  private async activate(child: Keeper) {
    const existing = this.store.bySession(this.who.id);
    if (this.joining && existing) throw new Error("session is already enrolled");
    if (this.joining && this.store.byMember(this.member!)) throw new Error("member already enrolled");
    const cut = existing?.cursor ?? (this.p.start === "now" ? await boardTail(args => boardCall(this.p, args)) : this.p.start);
    if (this.child !== child || child.stdin.destroyed || this.retired) return;
    verifyBoard(this.p);
    const owner = this.store.activate(this.who, this.member!, cut, this.joining !== undefined);
    this.owner = owner;
    this.cursor = owner.cursor;
    this.publisher = new Publisher(this.p, owner, this.store, (args, timeout) => boardCall(this.p, args, timeout),
      () => { if (this.requireOwner() !== owner) throw new Error("stale chatboard publisher"); });
    const joined = this.joining;
    this.joining = undefined;
    joined?.resolve();
    this.observeWakes();
    if (this.blocked) { this.state = "paused"; this.render(); }
    else this.ensureWait();
  }

  private event(child: Keeper, e: Record<string, unknown>) {
    if (this.retired || this.fatal || child.stdin.destroyed) return;
    switch (e.event) {
      case "ready":
        void this.activate(child).catch(error => {
          if (this.child !== child || this.retired) return;
          if (this.joining) {
            this.reason = (error as Error).message;
            child.stdin.destroy(); // The close handler rejects once the keeper has released its lease.
          } else this.fail(child, (error as Error).message);
        });
        break;
      case "busy": this.reason = "session address or group member is already live"; break;
      case "fault": this.reason = "listener keeper failed (board identity, lock file, or local Linux support)"; break;
      case "started":
        if (this.wait !== "requested" || !integer(e.pid, 1)) throw new Error("unexpected wait start");
        this.wait = "running";
        this.pid = e.pid;
        this.state = "listening";
        this.reason = undefined;
        this.render();
        break;
      case "batch": {
        if (this.wait !== "running") break;
        try { verifyBoard(this.p); }
        catch { this.fail(child, "bound Git common directory changed or disappeared"); break; }
        const batch = decodeBatch(e.data, this.topics, this.exclude);
        const result = this.store.admit(this.requireOwner(), batch);
        this.cursor = result.cursor;
        this.reason = undefined;
        this.failures = 0;
        if (result.blocked) {
          this.pause(result.blocked, result.blocked.includes("exceeds"));
          this.wait = "stopping";
          child.stdin.write("stop\n");
        }
        this.render();
        break;
      }
      case "oversize":
        if (this.wait === "stopping") break; // Wait for the explicitly requested stop acknowledgement.
        this.wait = "idle";
        this.pid = undefined;
        this.pause("board frame exceeds 8 MiB; blocked sequence is unknown", true);
        this.render();
        break;
      case "ended":
        if (this.wait === "stopping" && e.stopped !== true) break;
        this.wait = "idle";
        this.pid = undefined;
        if (e.stopped === true || (e.code === 2 && e.partial === false)) this.ensureWait();
        else this.schedule(`board wait ended (${e.deadline ? "deadline" : String(e.code)}); replaying`, () => this.ensureWait());
        break;
      default: throw new Error("unexpected listener event");
    }
  }

  private fail(child: Keeper, reason: string) {
    this.fatal = true;
    this.state = "unavailable";
    this.reason = reason;
    child.stdin.destroy();
    this.render();
  }

  private pause(reason: string, oversize: boolean) {
    this.blocked = { reason, oversize };
    this.state = "paused";
  }

  private schedule(reason: string, action: () => void) {
    if (this.retired || this.fatal || this.timer) return;
    this.state = "retrying";
    this.reason ??= reason;
    this.render();
    this.timer = setTimeout(() => { this.timer = undefined; action(); }, Math.min(5000, 150 * (2 ** Math.min(this.failures++, 6))));
  }

  private ensureWait() {
    if (this.retired || this.fatal || !this.owner || !this.child || this.child.stdin.destroyed
      || this.wait !== "idle" || this.timer || this.blocked) return;
    this.state = "connecting";
    this.wait = "requested";
    this.child.stdin.write(`start ${this.cursor}\n`);
    this.render();
  }

  // Only a committed same-session epoch signal reaches here. Keep a live wait;
  // let an in-flight cleanup/backoff finish. Never take a second initial cut.
  reconcile(who: Identity) {
    if (who.id !== this.who.id || who.path !== this.who.path) throw new Error("epoch event changed Pi session identity");
    if (this.child) this.ensureWait();
    else if (!this.timer) this.connect();
  }

  private requireOwner(): Membership {
    if (this.retired || this.fatal || !this.owner || !this.child || this.child.stdin.destroyed
      || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("no owned live chatboard enrollment");
    this.store.assertOwner(this.owner);
    return this.owner;
  }

  observeWakes() {
    if (!this.wakeTimer || !this.owner || this.retired) return;
    try {
      const owner = this.requireOwner();
      if (!this.store.hasRequestedWake(owner)) return;
      const receipts = this.wakeHost.receipts();
      this.store.observeWakes(owner, receipts);
      if (this.wakeRequest && receipts.includes(this.wakeRequest.id)) this.wakeRequest = undefined;
      this.wakeIssue = undefined;
    } catch { this.wakeIssue = "could not check Pi wake receipt"; }
  }

  private pumpWakes() {
    if (!this.owner || this.retired) return;
    try {
      if (!this.wakeHost.ready()) return;
      if (this.wakeRequest) {
        this.observeWakes();
        if (this.wakeRequest && Date.now() - this.wakeRequest.at < 30_000) return;
        // An unobserved submission stays requested, never resubmits. It must
        // not hold up unrelated handoffs forever if the host never starts it.
        this.wakeRequest = undefined;
      }
      const owner = this.requireOwner();
      verifyBoard(this.p);
      const request = this.store.claimWake(owner);
      if (!request) return;
      this.wakeRequest = { id: request.id, at: Date.now() };
      this.wakeHost.submit(request, owner.member === this.p.coordinator);
      this.wakeIssue = undefined;
    } catch { this.wakeIssue = "could not process pending chatboard wakes"; }
  }

  status() {
    return { state: this.state, group: this.p.group, member: this.member, session: this.who.id,
      cursor: this.cursor, ...this.store.counts(this.who.id), reason: this.blocked?.reason ?? this.reason,
      wakeIssue: this.wakeIssue,
      lastGap: this.store.lastGap(this.who.id), waiterPid: this.pid, keeperPid: this.child?.pid };
  }
  list(after: number) { return this.store.list(this.requireOwner(), after); }
  show(sequence: number) { return this.store.get(this.requireOwner(), sequence); }
  ack(sequence: number) {
    const removed = this.store.ack(this.requireOwner(), sequence);
    if (removed && this.blocked && !this.blocked.oversize) this.resume();
    this.render();
    return { removed, sequence };
  }
  skip(from: number, through: number) {
    return this.track(this.skipThrough(from, through));
  }
  private async skipThrough(from: number, through: number) {
    if (!this.blocked?.oversize) throw new Error("skip-through is available only on an oversize block");
    const owner = this.requireOwner();
    if (through > await boardTail(args => boardCall(this.p, args))) throw new Error("skip end is beyond the observed board tail");
    if (this.requireOwner() !== owner || !this.blocked?.oversize) throw new Error("oversize block or ownership changed");
    this.store.skip(owner, from, through);
    this.cursor = through;
    this.resume();
    return { skipped: { after: from, through }, continuity: "not established in this interval" };
  }
  private resume() {
    this.blocked = undefined;
    this.state = "connecting";
    this.ensureWait();
  }

  pending() {
    const owner = this.requireOwner();
    return { intents: this.store.pending(owner), handoffs: this.store.pendingHandoffs(owner) };
  }
  send(send: Send) { this.requireOwner(); return this.track(this.publisher!.send(send)); }
  report(body?: string) { this.requireOwner(); return this.track(this.publisher!.report(body)); }
  tell(messages: Tell[]) { this.requireOwner(); return this.track(this.publisher!.tell(messages)); }
  retry(id: string) { this.requireOwner(); return this.track(this.publisher!.retry(id)); }
  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => this.sends.delete(tracked));
    this.sends.add(tracked);
    return tracked;
  }

  private render() {
    const status = this.status();
    const label = this.member ? `${this.p.group}/${this.member}` : this.p.group;
    const text = `chatboard ${label}: ${status.state} · ${status.rows} unread${status.reason ? ` · ${status.reason}` : ""}`;
    if (this.lastStatus === text) return;
    this.lastStatus = text;
    this.display(text);
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.retired = true;
    clearTimeout(this.timer);
    clearInterval(this.wakeTimer);
    this.display(undefined);
    this.closing = (async () => {
      this.child?.stdin.end();
      await Promise.allSettled([this.closedChild, ...this.sends]);
      this.store.close();
    })();
    return this.closing;
  }
}
