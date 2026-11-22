import { randomUUID } from "node:crypto";
import { roleName, UUID, type Profile } from "./bindings.ts";
import { boardTail, readRows, row, type BoardCall, type Delivery, type Row } from "./board.ts";
import type { Membership, Store, StoredIntent, WakeState } from "./store.ts";

export type Send = {
  action: "report" | "note" | "forward";
  targets?: string[];
  body?: string;
  original?: Delivery;
};
export type Intent = {
  author: string; session_id: string; topic: string; body: string;
  references: string[]; role: string; to: string[]; since: number;
};
export type SendResult = { id: string; state: "unknown" | "confirmed" | "conflict"; sequence?: number };
export type Tell = Pick<Send, "targets" | "body">;
export type HandoffResult = SendResult & {
  messages: SendResult[];
  wakeSchedule: "waiting-for-board" | "blocked-by-conflict" | "pending" | "registered";
  wakes: { member: string; state: WakeState }[];
};
type Resolve = { byMember(alias: string): Membership | undefined; bySession(id: string): Membership | undefined };

export function intentFields(p: Profile, owner: Membership, lookup: Resolve, send: Send, exactWake = false): Omit<Intent, "since"> {
  const targets = send.action === "report" ? [p.coordinator] : send.targets;
  if (send.action === "report" && owner.member === p.coordinator) throw new Error("report is for lanes; use tell or note");
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 16) throw new Error("specify 1–16 recipients");
  const members = new Set<string>();
  const to = targets.map(target => {
    if (typeof target !== "string") throw new Error("recipient must be a member or session:UUID");
    const id = target.startsWith("session:") ? target.slice(8) : null;
    const recipient = id !== null ? (UUID.test(id) ? lookup.bySession(id) : undefined) : lookup.byMember(target);
    if (!recipient || recipient.namespace !== p.group || !p.members.includes(recipient.member)) {
      throw new Error("recipient is not enrolled in this group");
    }
    if (members.has(recipient.member)) throw new Error("duplicate recipient");
    members.add(recipient.member);
    if (exactWake && recipient.session === owner.session) throw new Error("tell is for other enrolled lanes; use note for self");
    return exactWake ? `session:${recipient.session}` : id ? `session:${id}` : `role:${roleName(p.group, recipient.member)}`;
  });
  const original = send.original?.row;
  if (send.action === "forward" && !original) throw new Error("select an original inbox sequence to forward");
  const body = send.body ?? (send.action === "forward" ? original?.body : undefined);
  if (typeof body !== "string" || !body.trim() || body.includes("\0") || Buffer.byteLength(body) > 16384
      || Buffer.from(body).toString("utf8") !== body) {
    throw new Error("body must be nonempty Unicode text, at most 16 KiB, without NUL");
  }
  if (original && !UUID.test(original.message_id)) throw new Error("original has no canonical board message ID");
  const role = roleName(p.group, owner.member);
  return { author: role, session_id: owner.session, topic: `pi-chatboard:${p.group}`, body,
    references: original ? [`chatboard:${original.sequence}:${original.message_id}`] : [], role, to };
}

const sameArray = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const match = (r: Row, i: Intent) => r.author === i.author && r.session_id === i.session_id
  && r.topic === i.topic && r.body === i.body && sameArray(r.references, i.references)
  && r.role === i.role && sameArray(r.to, i.to) && (r.wake === undefined || r.wake === false)
  && !["kind", "in_reply_to", "supersedes", "effects", "data", "contract_version"].some(k => k in r);

export function postArgs(i: Intent, id: string): string[] {
  return ["post", `--author=${i.author}`, `--session-id=${i.session_id}`, `--topic=${i.topic}`,
    `--body=${i.body}`, `--role=${i.role}`, `--message-id=${id}`,
    ...i.to.map(x => `--to=${x}`), ...i.references.map(x => `--ref=${x}`)];
}

async function locate(call: BoardCall, id: string, since: number): Promise<{ found?: Row; covered: boolean }> {
  // Fix the right edge so other active writers cannot keep reconciliation open.
  const tail = await boardTail(call);
  const deadline = Date.now() + 9000;
  let contiguous = true;
  for (let page = 0; page < 256 && since < tail; page++) {
    const remaining = deadline - Date.now();
    if (remaining < 1) break;
    const rows = readRows(await call(["read", "--since", String(since), "--limit", "16"], remaining));
    if (!rows.length) break;
    for (const r of rows) {
      if (r.sequence <= since) throw new Error("invalid board read ordering");
      if (r.sequence > tail) return { covered: false };
      if (r.message_id === id) return { found: r, covered: false };
      if (r.sequence !== since + 1) contiguous = false;
      since = r.sequence;
    }
  }
  return { covered: contiguous && since === tail };
}

export class Publisher {
  private busy: Promise<SendResult> | undefined;
  private p: Profile;
  private owner: Membership;
  private store: Store;
  private call: BoardCall;
  private owned: () => void;
  constructor(p: Profile, owner: Membership, store: Store, call: BoardCall, owned: () => void) {
    this.p = p;
    this.owner = owner;
    this.store = store;
    this.call = call;
    this.owned = owned;
  }

  send(send: Send): Promise<SendResult> {
    return this.exclusive(async () => {
      this.owned();
      const fields = intentFields(this.p, this.owner, this.store, send);
      const intent = { ...fields, since: await boardTail(this.call) };
      this.owned();
      const id = randomUUID();
      this.store.addIntent(this.owner, id, JSON.stringify(intent));
      return this.attempt(id, intent);
    });
  }

  tell(messages: Tell[]): Promise<HandoffResult> {
    return this.exclusive(async () => {
      this.owned();
      if (this.owner.member !== this.p.coordinator) throw new Error("only the configured coordinator can tell; use note for quiet sends");
      if (!Array.isArray(messages) || messages.length < 1 || messages.length > 8) throw new Error("tell needs 1–8 messages");
      const fields = messages.map(entry => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)
            || Object.keys(entry).some(k => k !== "targets" && k !== "body")) throw new Error("each tell message needs targets and body");
        return intentFields(this.p, this.owner, this.store, { ...entry, action: "note" }, true);
      });
      const since = await boardTail(this.call);
      this.owned();
      const id = randomUUID();
      const items = fields.map(f => ({ id: randomUUID(), payload: JSON.stringify({ ...f, since }) }));
      this.store.beginHandoff(this.owner, id, items);
      return this.publishHandoff(id, false);
    });
  }

  retry(id: string): Promise<SendResult | HandoffResult> {
    return this.exclusive(async () => {
      this.owned();
      if (!UUID.test(id)) throw new Error("expected an original intent or handoff ID");
      if (this.store.handoff(this.owner, id)) return this.publishHandoff(id, true);
      const stored = this.store.intent(this.owner, id);
      if (!stored) throw new Error("unknown local send intent or handoff");
      if (stored.state !== "unknown") return { id, state: stored.state, sequence: stored.sequence! };
      return this.retryItem(stored);
    });
  }

  private async retryItem(item: StoredIntent, requireCoverage = false): Promise<SendResult> {
    const intent: Intent = JSON.parse(item.payload);
    const readback = await this.locate(item.id, intent);
    if (readback.found) return this.settle(item.id, intent, readback.found);
    if (requireCoverage && !readback.covered) return { id: item.id, state: "unknown" };
    this.owned();
    return this.attempt(item.id, intent);
  }

  private async publishHandoff(id: string, retry: boolean): Promise<HandoffResult> {
    let items = this.store.handoff(this.owner, id)!;
    if (!items.some(item => item.state === "conflict")) {
      for (const item of items) {
        if (item.state === "confirmed") continue;
        this.owned();
        const receipt = retry ? await this.retryItem(item, true) : await this.attempt(item.id, JSON.parse(item.payload));
        if (receipt.state !== "confirmed") break;
      }
      items = this.store.handoff(this.owner, id)!;
    }
    const state = items.every(item => item.state === "confirmed") ? "confirmed"
      : items.some(item => item.state === "conflict") ? "conflict" : "unknown";
    if (state === "confirmed") {
      // The board effects are already confirmed. If the control write fails, keep
      // the original handoff retryable and do not hide the delivered sequences.
      try {
        this.owned();
        this.store.scheduleHandoff(this.owner, id);
        return this.handoffResult(id, state, items, this.store.handoffStatus(this.owner, id));
      } catch { /* original batch remains retryable without reposting */ }
    }
    return this.handoffResult(id, state, items);
  }

  private handoffResult(id: string, state: SendResult["state"], items: StoredIntent[],
    wakes: HandoffResult["wakes"] = []): HandoffResult {
    const messages = items.map(item => ({ id: item.id, state: item.state, sequence: item.sequence ?? undefined }));
    const sequence = items.length === 1 ? messages[0].sequence : undefined;
    const wakeSchedule = state === "unknown" ? "waiting-for-board" : state === "conflict" ? "blocked-by-conflict"
      : wakes.length ? "registered" : "pending";
    return { id, state, sequence, messages, wakeSchedule, wakes };
  }

  private exclusive<T extends SendResult>(call: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("another local send is still settling");
    const promise = call().finally(() => { this.busy = undefined; });
    this.busy = promise;
    return promise;
  }

  private async attempt(id: string, intent: Intent): Promise<SendResult> {
    let found: Row | undefined;
    try {
      const result = await this.call(postArgs(intent, id)) as { message?: unknown };
      const acknowledged = row(result.message);
      if (acknowledged.message_id === id) found = acknowledged;
    } catch { /* ambiguous effect; authoritative readback below */ }
    found ??= (await this.locate(id, intent)).found;
    return found ? this.settle(id, intent, found) : { id, state: "unknown" };
  }

  private async locate(id: string, intent: Intent): ReturnType<typeof locate> {
    try { return await locate(this.call, id, intent.since); }
    catch { return { covered: false }; }
  }

  private settle(id: string, i: Intent, r: Row): SendResult {
    const state = r.sequence > i.since && match(r, i) ? "confirmed" : "conflict";
    // May have lost ownership while a post was in flight; do not invent a receipt.
    try { this.owned(); this.store.finishIntent(this.owner, id, state, r.sequence); }
    catch { return { id, state: "unknown" }; }
    return { id, state, sequence: r.sequence };
  }
}
