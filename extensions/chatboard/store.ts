import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { missing, selectors, type Identity, type Profile } from "./bindings.ts";
import type { Batch, Delivery } from "./board.ts";

export type Membership = {
  session: string; transcript: string; namespace: string; member: string; scope: string;
  cursor: number; generation: string;
};
export type StoredDelivery = Delivery & { sequence: number };
export type StoredIntent = { id: string; payload: string; state: "unknown" | "confirmed" | "conflict"; sequence: number | null };
export type WakeRows = { id: string; sequence: number }[];
export type WakeState = "pending" | "requested" | "submitted";
export type WakeRequest = { id: string; rows: WakeRows };

export class Store {
  private db: DatabaseSync;
  private p: Profile;
  constructor(p: Profile) {
    this.p = p;
    const path = join(p.local, "inbox.sqlite3");
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("invalid inbox database file");
    } catch (e) { if (!missing(e)) throw e; }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 1500;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS board (
          slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS groups (
          namespace TEXT PRIMARY KEY, policy TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS memberships (
          session TEXT PRIMARY KEY, transcript TEXT UNIQUE NOT NULL, namespace TEXT NOT NULL
            REFERENCES groups(namespace), member TEXT NOT NULL, scope TEXT NOT NULL,
          cursor INTEGER NOT NULL, generation TEXT NOT NULL, UNIQUE(namespace, member)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS seen (
          session TEXT NOT NULL REFERENCES memberships(session), id TEXT NOT NULL,
          sequence INTEGER NOT NULL, PRIMARY KEY(session, id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS inbox (
          session TEXT NOT NULL REFERENCES memberships(session), sequence INTEGER NOT NULL,
          payload TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(session, sequence)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS gaps (
          session TEXT NOT NULL REFERENCES memberships(session), after_cursor INTEGER NOT NULL,
          through_cursor INTEGER NOT NULL, PRIMARY KEY(session, through_cursor)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS intents (
          id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES memberships(session),
          payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('unknown','confirmed','conflict')),
          sequence INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS handoffs (
          id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES memberships(session)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS handoff_items (
          handoff TEXT NOT NULL REFERENCES handoffs(id), intent TEXT PRIMARY KEY REFERENCES intents(id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS wakes (
          handoff TEXT NOT NULL REFERENCES handoffs(id), recipient TEXT NOT NULL REFERENCES memberships(session),
          state TEXT NOT NULL CHECK(state IN ('pending','requested','submitted')),
          rows TEXT NOT NULL, PRIMARY KEY(handoff, recipient)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS wakes_recipient ON wakes(recipient, state);
      `);
      const binding = JSON.stringify([1, p.common, p.device, p.inode]);
      this.db.prepare("INSERT OR IGNORE INTO board VALUES (1, ?)").run(binding);
      if (this.db.prepare("SELECT binding FROM board WHERE slot=1").get()?.binding !== binding) {
        throw new Error("saved inbox belongs to a different Git board identity");
      }
    } catch (e) { this.db.close(); throw e; }
  }

  close() { this.db.close(); }

  private transaction<T>(call: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = call();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  bySession(id: string): Membership | undefined {
    return this.db.prepare("SELECT * FROM memberships WHERE session=?").get(id) as Membership | undefined;
  }

  byMember(alias: string): Membership | undefined {
    return this.db.prepare("SELECT * FROM memberships WHERE namespace=? AND member=?")
      .get(this.p.group, alias) as Membership | undefined;
  }

  // Called only after the keeper holds both OS locks. Competing runtimes may
  // read the registry to resolve aliases but cannot replace an owned generation.
  activate(who: Identity, member: string, initialCursor: number, newOnly = false): Membership {
    const { group, coordinator, members, suppressSelf } = this.p;
    const scope = JSON.stringify([1, selectors(this.p, who, member), suppressSelf ? who.id : null]);
    const policy = JSON.stringify([coordinator, [...members].sort()]);
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO groups VALUES (?, ?)").run(group, policy);
      if (this.db.prepare("SELECT policy FROM groups WHERE namespace=?").get(group)?.policy !== policy) {
        throw new Error("configured group membership changed; use a new group");
      }
      const known = this.bySession(who.id);
      if (known && newOnly) throw new Error("session is already enrolled");
      if (known && (known.transcript !== who.path || known.namespace !== group
        || known.member !== member || known.scope !== scope)) {
        throw new Error("saved session identity or subscription conflicts with this profile");
      }
      if (!known && this.byMember(member)) {
        throw new Error("member already enrolled; stopping a session does not release its association");
      }
      const generation = randomUUID();
      if (known) {
        this.db.prepare("UPDATE memberships SET generation=? WHERE session=?").run(generation, who.id);
      } else {
        this.db.prepare("INSERT INTO memberships VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(who.id, who.path, group, member, scope, initialCursor, generation);
      }
      return this.bySession(who.id)!;
    });
  }

  assertOwner(owner: Membership): Membership {
    const current = this.bySession(owner.session);
    if (!current || current.generation !== owner.generation) throw new Error("stale chatboard subscription");
    return current;
  }

  counts(session: string): { rows: number; bytes: number } {
    return this.db.prepare("SELECT count(*) AS rows, coalesce(sum(bytes),0) AS bytes FROM inbox WHERE session=?")
      .get(session) as { rows: number; bytes: number };
  }

  admit(owner: Membership, batch: Batch): { blocked?: string; cursor: number } {
    return this.transaction(() => {
      const { cursor } = this.assertOwner(owner);
      if (batch.cursor < cursor) throw new Error("board cursor regressed");
      const next = batch.rows[0];
      if (next) {
        const { row } = next;
        if (row.sequence <= cursor) throw new Error("wait returned a row behind the committed cursor");
        const seen = this.db.prepare("SELECT sequence FROM seen WHERE session=? AND id=?")
          .get(owner.session, row.message_id);
        if (!seen) {
          const payload = JSON.stringify(next);
          const bytes = Buffer.byteLength(payload);
          const current = this.counts(owner.session);
          if (bytes > this.p.maxBytes) return { blocked: `row #${row.sequence} exceeds inbox byte capacity`, cursor };
          if (current.rows >= this.p.maxRows || current.bytes + bytes > this.p.maxBytes) {
            return { blocked: `inbox full; pending #${row.sequence}`, cursor };
          }
          this.db.prepare("INSERT INTO seen VALUES (?, ?, ?)").run(owner.session, row.message_id, row.sequence);
          this.db.prepare("INSERT INTO inbox VALUES (?, ?, ?, ?)").run(owner.session, row.sequence, payload, bytes);
        }
      }
      this.db.prepare("UPDATE memberships SET cursor=? WHERE session=?").run(batch.cursor, owner.session);
      return { cursor: batch.cursor };
    });
  }

  list(owner: Membership, after = 0, limit = 10): number[] {
    this.assertOwner(owner);
    return this.db.prepare("SELECT sequence FROM inbox WHERE session=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(owner.session, after, limit).map(r => r.sequence as number);
  }

  get(owner: Membership, sequence: number): StoredDelivery | undefined {
    this.assertOwner(owner);
    const item = this.db.prepare("SELECT payload FROM inbox WHERE session=? AND sequence=?").get(owner.session, sequence);
    return item ? { ...JSON.parse(item.payload as string), sequence } : undefined;
  }

  ack(owner: Membership, sequence: number): boolean {
    return this.transaction(() => {
      this.assertOwner(owner);
      return !!this.db.prepare("DELETE FROM inbox WHERE session=? AND sequence=?").run(owner.session, sequence).changes;
    });
  }

  skip(owner: Membership, from: number, through: number): void {
    this.transaction(() => {
      const current = this.assertOwner(owner);
      if (current.cursor !== from || through <= from) throw new Error("skip must start at the exact committed cursor");
      this.db.prepare("INSERT INTO gaps VALUES (?, ?, ?)").run(owner.session, from, through);
      this.db.prepare("UPDATE memberships SET cursor=? WHERE session=?").run(through, owner.session);
    });
  }

  lastGap(session: string) {
    return this.db.prepare("SELECT after_cursor AS after, through_cursor AS through FROM gaps WHERE session=? ORDER BY through_cursor DESC LIMIT 1").get(session);
  }

  pending(owner: Membership) {
    this.assertOwner(owner);
    return this.db.prepare(`SELECT id FROM intents i WHERE session=? AND state='unknown'
      AND NOT EXISTS (SELECT 1 FROM handoff_items h WHERE h.intent=i.id) ORDER BY rowid DESC LIMIT 16`)
      .all(owner.session).map(r => r.id as string);
  }

  addIntent(owner: Membership, id: string, payload: string) {
    this.transaction(() => {
      this.assertOwner(owner);
      this.db.prepare("INSERT INTO intents VALUES (?, ?, ?, 'unknown', NULL)").run(id, owner.session, payload);
    });
  }

  intent(owner: Membership, id: string): StoredIntent | undefined {
    this.assertOwner(owner);
    return this.db.prepare(`SELECT id, payload, state, sequence FROM intents i WHERE id=? AND session=?
      AND NOT EXISTS (SELECT 1 FROM handoff_items h WHERE h.intent=i.id)`)
      .get(id, owner.session) as StoredIntent | undefined;
  }

  private assertWakeDirection(owner: Membership, items: { payload: string }[]) {
    if (owner.member === this.p.coordinator) return;
    const coordinator = this.byMember(this.p.coordinator);
    const to = items.length === 1 ? JSON.parse(items[0].payload).to : undefined;
    if (!coordinator || !Array.isArray(to) || to.length !== 1 || to[0] !== `session:${coordinator.session}`) {
      throw new Error("a lane can wake only its enrolled coordinator with a single report");
    }
  }

  beginHandoff(owner: Membership, id: string, items: { id: string; payload: string }[]) {
    this.transaction(() => {
      this.assertWakeDirection(this.assertOwner(owner), items);
      this.db.prepare("INSERT INTO handoffs VALUES (?, ?)").run(id, owner.session);
      for (const item of items) {
        this.db.prepare("INSERT INTO intents VALUES (?, ?, ?, 'unknown', NULL)").run(item.id, owner.session, item.payload);
        this.db.prepare("INSERT INTO handoff_items VALUES (?, ?)").run(id, item.id);
      }
    });
  }

  handoff(owner: Membership, id: string): StoredIntent[] | undefined {
    this.assertOwner(owner);
    if (!this.db.prepare("SELECT 1 FROM handoffs WHERE id=? AND session=?").get(id, owner.session)) return;
    return this.db.prepare(`SELECT i.id, i.payload, i.state, i.sequence FROM handoff_items h
      JOIN intents i ON h.intent=i.id WHERE h.handoff=? ORDER BY i.rowid`).all(id) as StoredIntent[];
  }

  handoffStatus(owner: Membership, id: string) {
    this.assertOwner(owner);
    return this.db.prepare(`SELECT m.member, w.state FROM wakes w JOIN memberships m ON m.session=w.recipient
      JOIN handoffs h ON h.id=w.handoff WHERE w.handoff=? AND h.session=? ORDER BY m.member`)
      .all(id, owner.session).map(r => ({ member: r.member as string, state: r.state as WakeState }));
  }

  pendingHandoffs(owner: Membership) {
    this.assertOwner(owner);
    return this.db.prepare(`SELECT h.id FROM handoffs h WHERE h.session=? AND (
      EXISTS (SELECT 1 FROM wakes w WHERE w.handoff=h.id AND w.state!='submitted') OR (
        NOT EXISTS (SELECT 1 FROM wakes w WHERE w.handoff=h.id) AND NOT EXISTS (
          SELECT 1 FROM handoff_items hi JOIN intents i ON i.id=hi.intent WHERE hi.handoff=h.id AND i.state='conflict'
        )
      )) ORDER BY h.rowid DESC LIMIT 16`).all(owner.session).map(r => r.id as string);
  }

  scheduleHandoff(owner: Membership, id: string) {
    this.transaction(() => {
      const items = this.handoff(owner, id);
      if (!items?.length || items.some(item => item.state !== "confirmed")) throw new Error("handoff not fully confirmed");
      this.assertWakeDirection(this.assertOwner(owner), items);
      const dests = new Map<string, WakeRows>();
      for (const item of items) {
        const { to } = JSON.parse(item.payload) as { to: string[] };
        for (const target of to) {
          const session = target.startsWith("session:") ? target.slice(8) : "";
          const recipient = this.bySession(session);
          if (!recipient || recipient.namespace !== owner.namespace || recipient.session === owner.session) {
            throw new Error("invalid stored handoff recipient");
          }
          if (!dests.has(session)) dests.set(session, []);
          dests.get(session)!.push({ id: item.id, sequence: item.sequence! });
        }
      }
      // Publish the entire control batch together, and never reset a claimed wake on retry.
      const insert = this.db.prepare("INSERT OR IGNORE INTO wakes VALUES (?, ?, 'pending', ?)");
      for (const [session, rows] of dests) insert.run(id, session, JSON.stringify(rows));
    });
  }

  claimWake(owner: Membership): WakeRequest | undefined {
    // Read first: an idle group should not contend for a write lock on every tick.
    const ready = this.db.prepare(`SELECT handoff AS id, rows FROM wakes w
      WHERE w.recipient=? AND w.state='pending' AND NOT EXISTS (
        SELECT 1 FROM json_each(w.rows) want WHERE NOT EXISTS (
          SELECT 1 FROM inbox i JOIN seen s ON s.session=i.session AND s.sequence=i.sequence
          WHERE i.session=w.recipient AND i.sequence=json_extract(want.value, '$.sequence')
            AND s.id=json_extract(want.value, '$.id')
        )
      ) ORDER BY w.rowid LIMIT 1`);
    if (!ready.get(owner.session)) return;
    return this.transaction(() => {
      this.assertOwner(owner);
      const candidate = ready.get(owner.session) as { id: string; rows: string } | undefined;
      if (!candidate) return;
      this.db.prepare("UPDATE wakes SET state='requested' WHERE handoff=? AND recipient=? AND state='pending'")
        .run(candidate.id, owner.session);
      return { id: candidate.id, rows: JSON.parse(candidate.rows) as WakeRows };
    });
  }

  hasRequestedWake(owner: Membership): boolean {
    this.assertOwner(owner);
    return !!this.db.prepare("SELECT 1 FROM wakes WHERE recipient=? AND state='requested' LIMIT 1").get(owner.session);
  }

  observeWakes(owner: Membership, ids: string[]) {
    if (!ids.length) return;
    this.transaction(() => {
      this.assertOwner(owner);
      const mark = this.db.prepare("UPDATE wakes SET state='submitted' WHERE handoff=? AND recipient=? AND state='requested'");
      for (const id of ids) mark.run(id, owner.session);
    });
  }

  finishIntent(owner: Membership, id: string, state: "confirmed" | "conflict", sequence: number) {
    this.transaction(() => {
      this.assertOwner(owner);
      if (!this.db.prepare("UPDATE intents SET state=?, sequence=? WHERE session=? AND id=? AND state='unknown'")
        .run(state, sequence, owner.session, id).changes) throw new Error("send intent was already settled");
    });
  }
}
