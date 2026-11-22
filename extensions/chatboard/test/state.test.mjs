import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeBatch } from "../board.ts";
import { Publisher } from "../publish.ts";
import { Store } from "../store.ts";

function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(process.env.PI_CHATBOARD_SCRATCH ?? homedir(), ".pi-chatboard-unit-"));
  const common = join(dir, "common");
  mkdirSync(common);
  const { dev, ino } = statSync(common, { bigint: true });
  const profile = { group: "alpha", coordinator: "main", members: ["main", "lane"], suppressSelf: false,
    start: 0, common, device: String(dev), inode: String(ino), local: dir, maxRows: 1, maxBytes: 1024,
    ...overrides };
  const opened = [];
  const open = (p = profile) => {
    const store = new Store(p);
    opened.push(store);
    return store;
  };
  t.after(() => {
    for (const store of opened) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { profile, dir, open };
}

const who = path => ({ id: randomUUID(), path });
const row = (sequence, body = "message", message_id = randomUUID()) => ({ sequence, message_id, body });
const batch = (cursor, r) => ({ cursor, rows: r ? [{ row: r, matchedBy: ["to"] }] : [], status: r ? "messages" : "timeout" });

test("admission, dedup, capacity, release, quiet checkpoint and stale generation", t => {
  const { open, profile } = setup(t);
  const store = open();
  const w = who("/session.jsonl");
  const owner = store.activate(w, "main", 10);
  const first = row(11);
  assert.deepEqual(store.admit(owner, batch(12, first)), { cursor: 12 });
  const next = row(13);
  assert.equal(store.admit(owner, batch(14, next)).blocked, "inbox full; pending #13");
  assert.equal(store.bySession(w.id).cursor, 12);
  // A new connection resumes from the stored cut even if supplied a different initial cut.
  const nextStore = open();
  const reopened = nextStore.activate(w, "main", 90);
  assert.equal(reopened.cursor, 12);
  assert.throws(() => store.admit(owner, batch(14, next)), /stale/);
  assert.deepEqual(nextStore.list(reopened), [11]);
  assert.equal(nextStore.ack(reopened, 11), true);
  assert.deepEqual(nextStore.admit(reopened, batch(13, next)), { cursor: 13 });
  assert.deepEqual(nextStore.list(reopened), [13]);
  assert.equal(nextStore.ack(reopened, 13), true);
  assert.deepEqual(nextStore.admit(reopened, batch(14, row(14, first.body, first.message_id))), { cursor: 14 });
  assert.deepEqual(nextStore.list(reopened), []);
  assert.deepEqual(nextStore.admit(reopened, batch(19)), { cursor: 19 });
  assert.equal(nextStore.admit(reopened, batch(20, row(20, "x".repeat(1200)))).blocked, "row #20 exceeds inbox byte capacity");
  assert.throws(() => nextStore.skip(reopened, 18, 20), /exact committed cursor/);
  nextStore.skip(reopened, 19, 20);
  assert.deepEqual({ ...nextStore.lastGap(w.id) }, { after: 19, through: 20 });
  assert.throws(() => nextStore.activate(who("/unbound.jsonl"), "main", 30), /already enrolled/);
  const changed = open({ ...profile, suppressSelf: true });
  assert.throws(() => changed.activate(w, "main", 90), /conflicts/);
});

test("decode binds the canonical selectors and keeps unchanged rows with match provenance", () => {
  const topics = ["role:group-main", `session:${randomUUID()}`];
  const r = row(15);
  const base = { status: "messages", messages: [r], next_since: 17, topics, topic: null,
    exclude_session_id: null, has_more: false, matches: [{ sequence: 15, matched_by: ["topic", "to"] }] };
  assert.deepEqual(decodeBatch(base, topics, null), { status: "messages", rows: [{ row: r, matchedBy: ["topic", "to"] }], cursor: 17, hasMore: false });
  assert.throws(() => decodeBatch({ ...base, topics: ["all"] }, topics, null), /cross-bound/);
  assert.throws(() => decodeBatch({ ...base, control_events: [] }, topics, null), /cross-bound/);
  assert.throws(() => decodeBatch({ ...base, next_since: 13 }, topics, null), /ahead/);
});

test("lost post acknowledgement pages beyond the first page; absent, conflict and confirmation stay distinct", async t => {
  const { open, profile } = setup(t);
  const store = open();
  const lane = store.activate(who("/lane.jsonl"), "lane", 0);
  store.activate(who("/lead.jsonl"), "main", 0);
  let posts = 0, pages = 0, mode = "confirm";
  const history = [row(1, "previous")];
  const call = async args => {
    if (args[0] === "read") {
      if (args[1] !== "--since") return { messages: history.slice(-1) };
      pages++;
      return { messages: history.filter(r => r.sequence > Number(args[2])).slice(0, 16) };
    }
    posts++;
    const field = name => args.find(arg => arg.startsWith(`--${name}=`)).slice(name.length + 3);
    const id = field("message-id");
    if (mode !== "absent" && !history.some(r => r.message_id === id)) {
      for (let j = 0; j < 20; j++) history.push(row(history.length + 1));
      history.push({ ...row(history.length + 1, mode === "conflict" ? "wrong" : field("body"), id),
        observed_at: "owner attribute ignored", references: [], role: field("role"), author: field("author"),
        session_id: field("session-id"), topic: field("topic"), to: [field("to")] });
    }
    throw new Error("simulated lost acknowledgement");
  };
  const client = new Publisher(profile, lane, store, call, () => {});
  const one = await client.send({ action: "note", targets: ["main"], body: "--literal $HOME" });
  assert.equal(one.state, "confirmed");
  assert.ok(pages > 1);
  assert.equal(posts, 1);
  assert.deepEqual(await client.retry(one.id), one);
  assert.equal(posts, 1);
  mode = "conflict";
  assert.equal((await client.send({ action: "note", targets: ["main"], body: "intended" })).state, "conflict");
  mode = "absent";
  const missing = await client.send({ action: "note", targets: ["main"], body: "retain this ID" });
  assert.equal(missing.state, "unknown");
  assert.deepEqual(store.pending(lane), [missing.id]);
  mode = "confirm";
  const retried = await client.retry(missing.id);
  assert.equal(retried.id, missing.id);
  assert.equal(retried.state, "confirmed");
  assert.deepEqual(store.pending(lane), []);
  const before = posts;
  await assert.rejects(client.send({ action: "note", targets: [`session:${randomUUID()}`], body: "not allowed" }), /not enrolled/);
  assert.equal(posts, before);
});

function fixtureBoard() {
  const rows = [], attempts = [];
  let afterPost = () => {}, view = r => r;
  const call = async args => {
    if (args[0] === "read") {
      const visible = view(rows);
      return { messages: args[1] === "--since" ? visible.filter(r => r.sequence > Number(args[2])).slice(0, 16) : visible.slice(-1) };
    }
    const get = key => args.find(arg => arg.startsWith(`--${key}=`)).slice(key.length + 3);
    const id = get("message-id");
    attempts.push(id);
    assert.ok(!rows.some(r => r.message_id === id), "confirmed board row must not be posted again");
    const next = { ...row(rows.length + 1, get("body"), id), references: [], role: get("role"), author: get("author"),
      session_id: get("session-id"), topic: get("topic"), to: args.filter(a => a.startsWith("--to=")).map(a => a.slice(5)) };
    rows.push(next);
    afterPost(next);
    return { message: next };
  };
  return { rows, attempts, call, afterPost: f => { afterPost = f; }, view: f => { view = f; } };
}

test("batch waits for complete board confirmation and exact inbox rows; retry and ownership are durable", async t => {
  const { open, profile } = setup(t, { maxRows: 10 });
  const store = open(), board = fixtureBoard();
  const l = who("/lead.jsonl"), w = who("/lane.jsonl");
  const lead = store.activate(l, "main", 0);
  const lane = store.activate(w, "lane", 0);
  const pub = new Publisher(profile, lead, store, board.call, () => store.assertOwner(lead));
  const client = new Publisher(profile, lane, store, board.call, () => store.assertOwner(lane));
  const first = { targets: ["lane"], body: "first" }, second = { targets: [`session:${w.id}`], body: "second" };
  await assert.rejects(client.tell([first]), /configured coordinator/);
  await assert.rejects(pub.tell([first, { targets: ["missing"], body: "invalid destination" }]), /not enrolled/);
  assert.equal(board.attempts.length, 0);
  board.afterPost(r => {
    if (r.sequence === 2) {
      board.view(rows => rows.slice(0, 1));
      throw new Error("write committed, but acknowledgement and readback unavailable");
    }
  });
  const uncertain = await pub.tell([first, second]);
  assert.equal(uncertain.state, "unknown");
  assert.equal(uncertain.wakeSchedule, "waiting-for-board");
  assert.deepEqual(uncertain.messages.map(r => r.state), ["confirmed", "unknown"]);
  store.admit(lane, batch(1, board.rows[0]));
  assert.equal(store.claimWake(lane), undefined);
  assert.equal(board.attempts.length, 2);

  const reopened = open(), newLead = reopened.activate(l, "main", 0);
  const sender = new Publisher(profile, newLead, reopened, board.call, () => reopened.assertOwner(newLead));
  assert.deepEqual(reopened.pendingHandoffs(newLead), [uncertain.id]);
  // If the first unseen row might have been pruned, absence is not established.
  board.view(rows => [...rows.slice(0, 1), row(3)]);
  assert.equal((await sender.retry(uncertain.id)).state, "unknown");
  assert.equal(board.attempts.length, 2);
  board.view(rows => rows);
  const confirmed = await sender.retry(uncertain.id);
  assert.deepEqual(confirmed.wakes, [{ member: "lane", state: "pending" }]);
  assert.equal(board.attempts.length, 2);
  assert.equal(store.claimWake(lane), undefined, "one missing delivery must not wake");
  store.admit(lane, batch(2, board.rows[1]));
  assert.deepEqual(store.claimWake(lane), { id: uncertain.id,
    rows: board.rows.map(r => ({ id: r.message_id, sequence: r.sequence })) });
  assert.equal(store.claimWake(lane), undefined);

  // Simulate death in the durable-request/Pi-submission gap. A replacement
  // must not invent a receipt or replay an ambiguous start.
  const newLane = reopened.activate(w, "lane", 0);
  assert.equal(reopened.claimWake(newLane), undefined);
  assert.deepEqual((await sender.retry(uncertain.id)).wakes, [{ member: "lane", state: "requested" }]);
  assert.throws(() => store.observeWakes(lane, [uncertain.id]), /stale/);
  reopened.observeWakes(newLane, [randomUUID()]);
  assert.deepEqual(reopened.pendingHandoffs(newLead), [uncertain.id]);
  reopened.observeWakes(newLane, [uncertain.id]);
  assert.deepEqual((await sender.retry(uncertain.id)).wakes, [{ member: "lane", state: "submitted" }]);
  assert.equal(board.attempts.length, 2);
  assert.deepEqual(reopened.pendingHandoffs(newLead), []);
});

test("report confirms its board row before waking only the exact coordinator; retry does not repost", async t => {
  const { open, profile } = setup(t, { members: ["main", "lane", "other"] });
  const store = open(), board = fixtureBoard();
  const lane = store.activate(who("/lane.jsonl"), "lane", 0);
  const other = store.activate(who("/other.jsonl"), "other", 0);
  const sender = new Publisher(profile, lane, store, board.call, () => store.assertOwner(lane));
  await assert.rejects(sender.report("no coordinator yet"), /not enrolled/);
  const lead = store.activate(who("/lead.jsonl"), "main", 0);
  const item = to => ({ id: randomUUID(), payload: JSON.stringify({ to }) });
  for (const items of [
    [item([`session:${other.session}`])],
    [item([`session:${lead.session}`, `session:${other.session}`])],
    [item([`session:${lead.session}`]), item([`session:${lead.session}`])],
    [item(["role:alpha-main"])],
  ]) assert.throws(() => store.beginHandoff(lane, randomUUID(), items), /only its enrolled coordinator/);
  assert.deepEqual(store.pendingHandoffs(lane), []);
  assert.equal(board.attempts.length, 0);

  const schedule = store.scheduleHandoff.bind(store);
  store.scheduleHandoff = () => { throw new Error("simulated local control write failure"); };
  const receipt = await sender.report("finished");
  assert.equal(receipt.state, "confirmed");
  assert.equal(receipt.wakeSchedule, "pending");
  assert.deepEqual(board.rows[0].to, [`session:${lead.session}`]);
  assert.deepEqual(store.pendingHandoffs(lane), [receipt.id]);
  assert.equal(store.claimWake(lead), undefined);

  store.scheduleHandoff = schedule;
  const retried = await sender.retry(receipt.id);
  assert.equal(retried.wakeSchedule, "registered");
  assert.deepEqual(retried.messages, receipt.messages);
  assert.equal(board.attempts.length, 1);
  assert.equal(store.claimWake(lead), undefined, "confirmed post alone is not enough");
  store.admit(lead, batch(1, board.rows[0]));
  assert.equal(store.claimWake(lead).id, receipt.id);
  assert.equal(store.claimWake(other), undefined);
  assert.equal(store.claimWake(lane), undefined);
  assert.equal(store.claimWake(lead), undefined, "retry cannot resubmit an already requested wake");
});
