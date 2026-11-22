import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { digest, loadProfile } from "../bindings.ts";
import { boardCall } from "../board.ts";
import { Publisher } from "../publish.ts";
import { Store } from "../store.ts";

const extension = fileURLToPath(new URL("..", import.meta.url));
const source = process.env.PI_CHATBOARD_WORK_ENGINE ?? join(homedir(), "code", "work-engine");
const boardScript = join(source, "skills/durable-state/scripts/codex_chatboard.py");
const pi = process.env.PI_CHATBOARD_PI ?? "pi";
const cwd = process.env.PI_CHATBOARD_SCRATCH ?? homedir();
const producer = randomUUID();
const testFaux = fileURLToPath(new URL("../fixtures/faux.ts", import.meta.url));
const epochExtension = process.env.PI_CHATBOARD_EPOCH_EXTENSION ??
  join(homedir(), ".pi/agent/npm/node_modules/pi-context-epochs/src/index.ts");
const fauxModule = process.env.PI_CHATBOARD_FAUX_MODULE ??
  "/snap/pi-coding-agent/current/lib/pi/packages/ai/dist/providers/faux.js";
const fauxArgs = ["-e", testFaux, "--provider", "faux", "--model", "chatboard-fixture"];

function exec(file, args, opts = {}) {
  const result = spawnSync(file, args, { ...opts, encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${file} ${args[0]} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}
async function until(fn, describe, timeout = 12000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= end) throw new Error(`timed out: ${describe}`);
    await delay(30);
  }
}
const gone = pid => !existsSync(`/proc/${pid}`);
function procInfo(pid) {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(/\) /).at(-1); }
  catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
}

class Rpc {
  events = [];
  err = "";
  id = 0;
  constructor(c) {
    this.child = c;
    this.exited = new Promise(resolve => {
      c.once("close", (code, signal) => resolve({ code, signal }));
      c.on("error", e => { this.err += String(e); });
    });
    c.stdin.on("error", e => { this.err += String(e); });
    createInterface({ input: c.stdout }).on("line", line => {
      try { this.events.push(JSON.parse(line)); }
      catch { this.err += `non-JSON stdout: ${line}\n`; }
    });
    c.stderr.on("data", chunk => { this.err += chunk; });
    // The owning lab closes Pi and its lease before removing scratch files.
  }
  async request(type, fields = {}) {
    const id = String(++this.id);
    this.child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    const r = await until(() => {
      const found = this.events.find(e => e.type === "response" && e.id === id);
      if (!found && (this.child.exitCode !== null || this.child.signalCode !== null)) {
        throw new Error(`Pi exited: ${this.err}\n${JSON.stringify(this.events.slice(-4))}`);
      }
      return found;
    }, `RPC ${type}`);
    assert.equal(r.success, true, JSON.stringify(r));
    return r.data;
  }
  async prompt(text) {
    const cut = this.events.length;
    await this.request("prompt", { message: text });
    await until(() => this.events.slice(cut).some(e => e.type === "agent_end"), "fixture turn ends");
  }
  async command(command) {
    const cut = this.events.length;
    await this.request("prompt", { message: `/chatboard ${command}` });
    const item = await until(() => this.events.slice(cut).find(e => e.type === "extension_ui_request"
      && e.method === "notify" && typeof e.message === "string" && e.message.startsWith("{")), `chatboard ${command}`);
    return JSON.parse(item.message);
  }
  async status(check = () => true) {
    let last;
    return until(async () => {
      last = await this.command("status");
      return check(last) && last;
    }, "chatboard status").catch(e => { throw new Error(`${e.message}; last status: ${JSON.stringify(last)}; ${this.err}`); });
  }
  assertQuiet() {
    assert.deepEqual(this.events.filter(e => ["agent_start", "turn_start", "extension_error"].includes(e.type)), []);
  }
  async close() {
    this.child.stdin.end();
    const watchdog = setTimeout(() => this.child.kill("SIGKILL"), 6000);
    try { return await this.exited; }
    finally { clearTimeout(watchdog); }
  }
}

function lab(t, options = {}) {
  const root = mkdtempSync(join(cwd, ".pi-chatboard-test-"));
  const repo = join(root, "repo"), agent = join(root, "agent"), sessions = join(root, "sessions");
  const stateDir = join(root, "state"), profile = join(root, "profile.json");
  for (const dir of [repo, agent, sessions]) mkdirSync(dir, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: root, LC_ALL: "C.UTF-8", PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  exec("git", ["init", "--quiet", "--ref-format=files", repo], { env });
  const config = { version: 1, repository: repo, python: "/usr/bin/python3", boardScript,
    path: ["/usr/bin"], stateDir, group: "alpha", coordinator: "lead",
    members: ["lead", "one", "two", "three", "four", "five"], ...options };
  const setProfile = (overrides = {}, path = profile) => writeFileSync(path, JSON.stringify({ ...config, ...overrides }), { mode: 0o600 });
  setProfile();
  function board(...args) { return JSON.parse(exec(config.python, ["-I", "-B", boardScript, "--repository", repo, ...args], { env })); }
  const owned = [];
  t.after(async () => {
    await Promise.all(owned.map(rpc => rpc.close()));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, agent, sessions, profile, env, setProfile, board,
    hasDurableDelivery(id, sequence) {
      const bucket = createHash("sha256").update(join(repo, ".git")).digest("hex");
      const db = new DatabaseSync(join(stateDir, bucket, "inbox.sqlite3"), { readOnly: true });
      try { return Boolean(db.prepare("SELECT 1 FROM inbox WHERE session=? AND sequence=?").get(id, sequence)); }
      finally { db.close(); }
    },
    post(topic, body, ...args) {
      return board("post", "--author=fixture", `--session-id=${producer}`, `--topic=${topic}`, `--body=${body}`, ...args).message;
    },
    rpc(member, { id = randomUUID(), file, profilePath = profile, extras = [], envExtras = {} } = {}) {
      const args = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
        "--no-mcp", "--no-approve", "--mode", "rpc", "-e", extension, "--session-dir", sessions,
        ...(file ? ["--session", file] : ["--session-id", id]), ...extras];
      const rpc = new Rpc(spawn(pi, args, { cwd: repo, env: { ...env, ...envExtras,
        CHATBOARD_MODEL_MODULE: fauxModule, PI_CHATBOARD_PROFILE: profilePath,
        ...(member === undefined ? {} : { PI_CHATBOARD_MEMBER: member }),
      } }));
      owned.push(rpc);
      return { rpc, id };
    },
  };
}

const listening = s => s.state === "listening" && s.waiterPid;
const count = n => s => s.rows === n && s.state === "listening";

test("private manifest is opt-in and a fresh Pi listens without a prompt or transcript", { timeout: 30000 }, async t => {
  const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.equal(root.pi.extensions.some(p => p.includes("chatboard")), false);
  const fixture = lab(t);
  const old = fixture.post("role:alpha-one", "before the cut");
  const { rpc, id } = fixture.rpc("one", { envExtras: { GIT_DIR: "/not-this-board", PYTHONPATH: "/not-imported", PI_SESSION_ID: randomUUID() } });
  const active = await rpc.status(listening);
  assert.equal(active.cursor, old.sequence);
  assert.equal(active.session, id);
  const { sessionFile } = await rpc.request("get_state");
  assert.ok(sessionFile);
  assert.equal(existsSync(sessionFile), false);
  fixture.post("all", "not a wildcard");
  fixture.post("job:other", "not directed", "--wake");
  const row = fixture.post("all", "directed", `--to=session:${id}`, "--to=role:alpha-one", "--wake");
  assert.equal((await rpc.status(count(1))).cursor, row.sequence);
  assert.deepEqual(await rpc.command("inbox"), { sequences: [row.sequence] });
  const delivery = JSON.parse((await rpc.command(`show ${row.sequence}`)).jsonFragment);
  assert.deepEqual(delivery.row, row);
  assert.deepEqual(delivery.matchedBy, ["to"]);
  assert.equal(existsSync(sessionFile), false);
  rpc.assertQuiet();
  assert.deepEqual(await rpc.close(), { code: 0, signal: null });
  await until(() => gone(active.waiterPid) && gone(active.keeperPid), "graceful watcher closure");
});

test("six fresh Pi sessions route quiet report, note, direct ID and selected forward only", { timeout: 45000 }, async t => {
  const fixture = lab(t, { suppressSelf: true });
  const names = ["lead", "one", "two", "three", "four", "five"];
  const [lead, one, two, three, four, five] = names.map(m => fixture.rpc(m));
  const all = [lead, one, two, three, four, five];
  await Promise.all(all.map(({ rpc }) => rpc.status(listening)));
  const foreignPath = join(fixture.root, "foreign.json");
  fixture.setProfile({ group: "beta" }, foreignPath);
  const foreign = fixture.rpc("one", { profilePath: foreignPath });
  await foreign.rpc.status(listening);
  const report = await one.rpc.command("report Ready for integration");
  assert.equal(report.state, "confirmed", JSON.stringify(report));
  await lead.rpc.status(count(1));
  const original = JSON.parse((await lead.rpc.command(`show ${report.sequence}`)).jsonFragment).row;
  assert.deepEqual(original.to, ["role:alpha-lead"]);
  assert.equal(original.session_id, one.id);
  assert.equal(original.body, "Ready for integration");
  const inert = "$(touch not-executed); `echo still-text`";
  const tell = await lead.rpc.command(`note two,session:${three.id} ${inert}`);
  assert.equal(tell.state, "confirmed", JSON.stringify(tell));
  const forward = await lead.rpc.command(`forward ${report.sequence} four Please check`);
  assert.equal(forward.state, "confirmed", JSON.stringify(forward));
  fixture.post("job:unrelated", "filtered even with wake", "--wake");
  const sentinel = fixture.post("job:verification", "addressed barrier; verify exact prefix",
    ...[...all, foreign].map(({ id }) => `--to=session:${id}`)).sequence;
  const expected = [[report.sequence], [], [tell.sequence], [tell.sequence], [forward.sequence], [], []];
  await Promise.all([...all, foreign].map(async ({ rpc }, i) => {
    await rpc.status(s => s.state === "listening" && s.cursor >= sentinel);
    assert.deepEqual((await rpc.command("inbox")).sequences, [...expected[i], sentinel]);
    rpc.assertQuiet();
  }));
  assert.equal(JSON.parse((await two.rpc.command(`show ${tell.sequence}`)).jsonFragment).row.body, inert);
  assert.equal(existsSync(join(fixture.repo, "not-executed")), false);
  const forwarded = JSON.parse((await four.rpc.command(`show ${forward.sequence}`)).jsonFragment).row;
  assert.deepEqual(forwarded.to, ["role:alpha-four"]);
  assert.deepEqual(forwarded.references, [`chatboard:${original.sequence}:${original.message_id}`]);
  for (const target of ["all", "beta-one", `session:${foreign.id}`, `session:${randomUUID()}`]) {
    assert.ok((await lead.rpc.command(`tell ${target} must not post`)).error);
  }
  assert.equal(fixture.board("read", "--limit=1").messages.at(-1).sequence, sentinel);
  fixture.post("all", "filtered own echo", `--session-id=${one.id}`, `--to=session:${one.id}`);
  const wake = fixture.post("all", "canonical own wake bypass", `--session-id=${one.id}`, `--to=session:${one.id}`, "--wake");
  await one.rpc.status(s => s.cursor === wake.sequence);
  assert.deepEqual((await one.rpc.command("inbox")).sequences, [sentinel, wake.sequence]);
  one.rpc.assertQuiet();
});

function handoffModel(fixture, options = {}) {
  return { extras: fauxArgs, envExtras: { CHATBOARD_MODEL_LAB: fixture.root, CHATBOARD_HANDOFF_TEST: JSON.stringify(options) } };
}
const starts = rpc => rpc.events.filter(e => e.type === "agent_start").length;
const ends = rpc => rpc.events.filter(e => e.type === "agent_end").length;
const transcriptWakes = file => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line))
  .filter(e => e.type === "custom_message" && e.customType === "pi-chatboard/handoff-v1");
const boardRows = fixture => fixture.board("read", "--since=0", "--limit=32").messages;

async function checkWake({ rpc, id }, receipt, sequences, turnCount = 1) {
  await until(() => ends(rpc) === turnCount, `recipient ${id} completes ${turnCount} run(s)`)
    .catch(e => { throw new Error(`${e.message}; ${rpc.err}; ${JSON.stringify(rpc.events.slice(-6))}`); });
  assert.equal(starts(rpc), turnCount);
  const state = await rpc.request("get_state");
  assert.equal(state.pendingMessageCount, 0);
  const [wake, ...others] = transcriptWakes(state.sessionFile);
  assert.equal(others.length, 0);
  assert.deepEqual(wake.details, { id: receipt, recipient: id });
  assert.deepEqual([...wake.content.matchAll(/#(\d+)/g)].map(m => Number(m[1])), sequences);
  return wake;
}

for (const busy of [false, true]) {
  test(`one coordinator tell wakes each ${busy ? "settling" : "idle"} Pi once, then the model reads and reports`,
    { timeout: 35000 }, async t => {
      const fixture = lab(t);
      const one = fixture.rpc("one", handoffModel(fixture, { hold: busy }));
      const two = fixture.rpc("two", handoffModel(fixture));
      const bystander = fixture.rpc("three", handoffModel(fixture));
      const batch = [{ targets: ["one", `session:${two.id}`], body: "first protected only by normal board access" },
        { targets: ["one"], body: "second assignment only for one" }];
      const lead = fixture.rpc("lead", handoffModel(fixture, { send: batch }));
      await Promise.all([lead, one, two, bystander].map(({ rpc }) => rpc.status(listening)));
      const bad = await one.rpc.command("tell two unauthorized wake");
      assert.match(bad.error, /configured coordinator/);
      assert.deepEqual(boardRows(fixture), []);
      const quiet = await lead.rpc.command("note one,two ordinary note");
      assert.equal(quiet.state, "confirmed");
      const external = fixture.post("fixture", "not a wake capability", `--to=session:${one.id}`, "--wake");
      await Promise.all([one.rpc.status(s => s.cursor >= external.sequence), two.rpc.status(s => s.cursor >= quiet.sequence)]);
      one.rpc.assertQuiet(); two.rpc.assertQuiet(); bystander.rpc.assertQuiet();
      const mark = name => join(fixture.root, name);
      if (busy) {
        await one.rpc.request("prompt", { message: "Begin held run" });
        await until(() => existsSync(mark("busy")), "recipient entered held tool");
      }
      // One actual model tool call; no send, wake, or prompt on the idle recipients.
      await lead.rpc.prompt("Dispatch the two-message handoff using the chatboard tool once.");
      const toolEnd = lead.rpc.events.filter(e => e.type === "tool_execution_end" && e.toolName === "chatboard");
      assert.equal(toolEnd.length, 1, JSON.stringify(lead.rpc.events.slice(-6)));
      assert.equal(toolEnd[0].isError, false);
      const receipt = JSON.parse(toolEnd[0].result.content[0].text);
      assert.equal(receipt.state, "confirmed");
      assert.equal(receipt.wakeSchedule, "registered");
      assert.deepEqual(receipt.wakes.map(r => r.member), ["one", "two"]);
      const sequences = receipt.messages.map(r => r.sequence);
      const committed = boardRows(fixture).filter(r => sequences.includes(r.sequence));
      assert.deepEqual(committed.map(r => r.body), batch.map(m => m.body));
      assert.ok(committed.every(r => r.wake !== true));
      if (busy) {
        await one.rpc.status(s => s.cursor >= sequences[1]);
        assert.equal(starts(one.rpc), 1);
        assert.equal((await one.rpc.request("get_state")).pendingMessageCount, 0);
        writeFileSync(mark("busy-release"), "release");
        await until(() => existsSync(mark("settling")), "settlement held after low-level agent end");
        // Let the other recipient finish before ending the settle hook; it is
        // independent and must not be serialized behind the busy lane.
        await checkWake(two, receipt.id, sequences.slice(0, 1));
        await until(async () => (await lead.rpc.command(`retry ${receipt.id}`)).wakes
          .some(w => w.member === "one" && w.state === "requested"), "local wake request recorded during Pi settlement");
        assert.equal(starts(one.rpc), 1);
        writeFileSync(mark("settling-release"), "release");
      } else await checkWake(two, receipt.id, sequences.slice(0, 1));
      const wake = await checkWake(one, receipt.id, sequences, busy ? 2 : 1);
      for (const { body } of batch) assert.ok(!wake.content.includes(body));
      const reports = boardRows(fixture).filter(r => r.body.startsWith("read: "));
      assert.deepEqual(new Map(reports.map(r => [r.session_id, JSON.parse(r.body.slice(6))])),
        new Map([[one.id, batch.map(m => m.body)], [two.id, [batch[0].body]]]));
      const before = boardRows(fixture);
      const retry = await lead.rpc.command(`retry ${receipt.id}`);
      assert.deepEqual(retry.wakes, [{ member: "one", state: "submitted" }, { member: "two", state: "submitted" }]);
      assert.deepEqual(boardRows(fixture), before);
      assert.deepEqual((await bystander.rpc.command("inbox")).sequences, []);
      bystander.rpc.assertQuiet();
    });
}

test("closed destination stays pending; sender restart/retry and recipient resume do not repost or re-wake", { timeout: 35000 }, async t => {
  const fixture = lab(t);
  const model = handoffModel(fixture);
  const lead = fixture.rpc("lead", model), one = fixture.rpc("one", model);
  await Promise.all([lead, one].map(({ rpc }) => rpc.status(listening)));
  await Promise.all([lead, one].map(({ rpc }) => rpc.prompt("Persist this enrolled session")));
  const lfile = (await lead.rpc.request("get_state")).sessionFile;
  const ofile = (await one.rpc.request("get_state")).sessionFile;
  await one.rpc.close();
  const receipt = await lead.rpc.command("tell one assignment while closed");
  assert.equal(receipt.state, "confirmed");
  assert.deepEqual(receipt.wakes, [{ member: "one", state: "pending" }]);
  assert.deepEqual(transcriptWakes(ofile), []);
  const before = boardRows(fixture);
  assert.equal(before.length, 1);
  await lead.rpc.close();
  const reopened = fixture.rpc(undefined, { ...model, file: lfile });
  await reopened.rpc.status(listening);
  assert.deepEqual((await reopened.rpc.command("pending")).handoffs, [receipt.id]);
  assert.deepEqual(await reopened.rpc.command(`retry ${receipt.id}`), receipt);
  assert.deepEqual(boardRows(fixture), before);
  const receiver = fixture.rpc(undefined, { ...model, file: ofile, id: one.id });
  await checkWake(receiver, receipt.id, [receipt.sequence]);
  const after = boardRows(fixture);
  assert.equal(after.length, 2);
  assert.equal(after[1].body, 'read: ["assignment while closed"]');
  await receiver.rpc.close();
  const again = fixture.rpc(undefined, { ...model, file: ofile, id: one.id });
  await again.rpc.status(listening);
  const retry = await reopened.rpc.command(`retry ${receipt.id}`);
  assert.deepEqual(retry.wakes, [{ member: "one", state: "submitted" }]);
  assert.deepEqual(boardRows(fixture), after);
  assert.equal(transcriptWakes(ofile).length, 1);
  again.rpc.assertQuiet();
});

test("waiter loss and Pi death recover from committed position after retiring a nested Git process", { timeout: 45000 }, async t => {
  const fixture = lab(t);
  const bin = join(fixture.root, "bin"), arm = join(fixture.root, "arm"), ready = join(fixture.root, "nested.json");
  mkdirSync(bin, { mode: 0o700 });
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, `#!/usr/bin/python3\nimport json, os, signal, subprocess, sys\narm = ${JSON.stringify(arm)}\nready = ${JSON.stringify(ready)}\nrepo = ${JSON.stringify(fixture.repo)}\nif os.environ.get('WORK_ENGINE_REGISTRY_FENCE_FD') and os.path.isfile(arm) and sys.argv[3:] == ['rev-parse', '--git-dir']:\n    child = subprocess.Popen(['/usr/bin/git', '-C', repo, 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)\n    with open(ready + '.tmp', 'w') as out:\n        json.dump([os.getpid(), child.pid, os.getpgid(0)], out)\n    os.rename(ready + '.tmp', ready)\n    signal.pause()\nos.execv('/usr/bin/git', ['/usr/bin/git', *sys.argv[1:]])\n`);
  chmodSync(wrapper, 0o700);
  fixture.setProfile({ path: [bin, "/usr/bin"] });
  const active = fixture.rpc("one", { extras: fauxArgs, envExtras: { CHATBOARD_MODEL_LAB: fixture.root } });
  const first = await active.rpc.status(listening);
  await active.rpc.prompt("Create a real transcript before abrupt host loss");
  const { sessionFile } = await active.rpc.request("get_state");
  assert.ok(existsSync(sessionFile));
  const retained = fixture.post("role:alpha-one", "durable before loss");
  await active.rpc.status(count(1));
  process.kill(first.waiterPid, "SIGKILL");
  const loss = fixture.post("role:alpha-one", "while canonical waiter was down");
  const recovered = await active.rpc.status(s => count(2)(s) && s.waiterPid !== first.waiterPid);
  assert.equal(recovered.keeperPid, first.keeperPid);
  assert.equal(recovered.cursor, loss.sequence);
  assert.ok(gone(first.waiterPid));
  writeFileSync(arm, "hold");
  process.kill(recovered.waiterPid, "SIGKILL"); // forces a new canonical waiter through the barrier
  const [nested, realGit, leader] = await until(() => existsSync(ready) && JSON.parse(readFileSync(ready, "utf8")), "nested Git running under wait");
  await until(() => {
    const states = [nested, realGit, leader].map(pid => procInfo(pid));
    return states.every(state => state && !state.startsWith("Z"));
  }, `nested Git stable in wait group ${leader}, wrapper ${nested}, Git ${realGit}`);
  assert.match(readFileSync(`/proc/${realGit}/cmdline`, "utf8"), /\/usr\/bin\/git\0.*cat-file/s);
  const p = loadProfile(fixture.profile);
  // Test the two kernel fences independently of durable association checks:
  // same session address, but a different group/member and selector policy.
  const lockProof = exec(p.python, ["-I", "-B", join(extension, "keeper.py"), p.local, digest(active.id),
    digest(JSON.stringify(["beta", "two"])), p.script, p.common, p.device, p.inode,
    `session:${active.id}`, "role:beta-two", active.id], { env: p.env });
  assert.deepEqual(JSON.parse(lockProof), { event: "busy" });
  const duplicate = fixture.rpc(undefined, { file: sessionFile });
  const sameMember = fixture.rpc("one");
  const blocked = s => s.state === "retrying" && /already live/.test(s.reason);
  await Promise.all([duplicate.rpc.status(blocked), sameMember.rpc.status(blocked)]);
  rmSync(arm);
  active.rpc.child.kill("SIGKILL");
  const during = fixture.post("role:alpha-one", "after Pi death before takeover commits");
  const next = await duplicate.rpc.status(count(3));
  assert.equal(next.cursor, during.sequence);
  assert.notEqual(next.keeperPid, first.keeperPid);
  // The old group is gone by the time the replacement admits, not just at teardown.
  assert.ok([nested, realGit, leader].every(gone));
  await until(() => gone(first.keeperPid), "orphaned keeper reaped by init");
  assert.equal((await active.rpc.exited).signal, "SIGKILL");
  assert.deepEqual((await duplicate.rpc.command("inbox")).sequences, [retained.sequence, loss.sequence, during.sequence]);
  assert.equal((await sameMember.rpc.status(s => s.state === "retrying" || s.state === "unavailable")).member, "one");
  duplicate.rpc.assertQuiet();
  sameMember.rpc.assertQuiet();
});

test("inbox capacity pauses without a cursor gap; exact release and explicit oversize recovery", { timeout: 30000 }, async t => {
  const fixture = lab(t, { maxRows: 1, maxBytes: 1024 });
  const { rpc } = fixture.rpc("one");
  await rpc.status(listening);
  const one = fixture.post("role:alpha-one", "keep first");
  const two = fixture.post("role:alpha-one", "pending second");
  const large = fixture.post("role:alpha-one", "x".repeat(2048));
  const four = fixture.post("role:alpha-one", "after oversize");
  const paused = await rpc.status(s => s.state === "paused" && !s.waiterPid);
  assert.match(paused.reason, /full/);
  assert.equal(paused.cursor, one.sequence);
  assert.deepEqual(await rpc.command(`ack ${one.sequence}`), { removed: true, sequence: one.sequence });
  const oversize = await rpc.status(s => s.state === "paused" && !s.waiterPid && /exceeds/.test(s.reason));
  assert.equal(oversize.cursor, two.sequence);
  assert.ok((await rpc.command(`skip-through ${one.sequence} ${large.sequence}`)).error);
  assert.match((await rpc.command(`skip-through ${two.sequence} ${four.sequence + 1}`)).error, /beyond/);
  assert.equal((await rpc.command(`ack ${two.sequence}`)).removed, true);
  assert.deepEqual(await rpc.command(`skip-through ${two.sequence} ${large.sequence}`), {
    skipped: { after: two.sequence, through: large.sequence }, continuity: "not established in this interval",
  });
  const replayed = await rpc.status(s => count(1)(s) && s.cursor === four.sequence);
  assert.deepEqual(replayed.lastGap, { after: two.sequence, through: large.sequence });
  assert.deepEqual((await rpc.command("inbox")).sequences, [four.sequence]);
  rpc.assertQuiet();
});

test("authoritative startup cut survives a delayed first reader and a real quiet timeout rearms", { timeout: 30000 }, async t => {
  const fixture = lab(t);
  const marker = join(fixture.root, "reader-ready"), release = join(fixture.root, "reader-release");
  const hook = join(fixture.root, "board-fixture.py");
  const script = `import os, pathlib, runpy, sys, time\nif sys.argv[3] == 'wait' and not os.path.exists(${JSON.stringify(marker)}):\n    pathlib.Path(${JSON.stringify(marker)}).touch()\n    deadline = time.monotonic() + 9\n    while not os.path.exists(${JSON.stringify(release)}):\n        if time.monotonic() >= deadline:\n            sys.exit(1)\n        time.sleep(0.025)\n    sys.argv[sys.argv.index('--timeout-seconds') + 1] = '0.35'\nrunpy.run_path(${JSON.stringify(boardScript)}, run_name='__main__')\n`;
  writeFileSync(hook, script);
  fixture.setProfile({ boardScript: hook });
  for (let i = 0; i < 4; i++) fixture.post("role:alpha-one", `matched history ${i}`);
  const lastOld = fixture.post("all", "unmatched but authoritative tail");
  const { rpc } = fixture.rpc("one");
  await until(() => existsSync(marker), "first wait paused after enrollment cut");
  const initial = await rpc.status(listening);
  assert.equal(initial.cursor, lastOld.sequence);
  assert.equal(initial.rows, 0);
  const between = fixture.post("role:alpha-one", "post after cut, before wait actually reads");
  writeFileSync(release, "continue");
  const rearmed = await rpc.status(s => count(1)(s) && s.waiterPid !== initial.waiterPid);
  assert.equal(rearmed.keeperPid, initial.keeperPid);
  assert.equal(rearmed.cursor, between.sequence);
  assert.ok(gone(initial.waiterPid));
  const after = fixture.post("role:alpha-one", "post after quiet rearms");
  await rpc.status(count(2));
  assert.deepEqual((await rpc.command("inbox")).sequences, [between.sequence, after.sequence]);
  rpc.assertQuiet();
});

test("a genuinely committed post with a discarded acknowledgement is read back beyond page one", { timeout: 30000 }, async t => {
  const fixture = lab(t);
  const p = loadProfile(fixture.profile);
  const store = new Store(p);
  try {
    const session = { id: randomUUID(), path: join(fixture.sessions, "lead.jsonl") };
    const recipient = { id: randomUUID(), path: join(fixture.sessions, "one.jsonl") };
    const owner = store.activate(session, "lead", 0);
    store.activate(recipient, "one", 0);
    let posts = 0;
    const pub = new Publisher(p, owner, store, async (args, timeout) => {
      if (args[0] !== "post") return boardCall(p, args, timeout);
      posts++;
      for (let i = 0; i < 17; i++) fixture.post("all", `interleaved publisher ${i}`);
      await boardCall(p, args, timeout);
      throw new Error("fixture discards the real committed response");
    }, () => store.assertOwner(owner));
    const confirmed = await pub.send({ action: "note", targets: ["one"], body: "exact intended send" });
    assert.equal(confirmed.state, "confirmed");
    assert.equal(confirmed.sequence, 18);
    assert.deepEqual(await pub.retry(confirmed.id), confirmed);
    assert.equal(posts, 1);
    const exact = fixture.board("read", "--since=0", "--limit=32").messages.filter(r => r.message_id === confirmed.id);
    assert.equal(exact.length, 1);
    assert.equal(exact[0].body, "exact intended send");
  } finally { store.close(); }
});

test("real Pi reload, graceful resume, switch, fork and new keep the correct enrollment", { timeout: 40000 }, async t => {
  const fixture = lab(t);
  const modelOpts = { extras: fauxArgs, envExtras: { CHATBOARD_MODEL_LAB: fixture.root } };
  const a = fixture.rpc("one", modelOpts);
  const b = fixture.rpc("two", modelOpts);
  const [first, second] = await Promise.all([a.rpc.status(listening), b.rpc.status(listening)]);
  await a.rpc.prompt("Persist the first transcript");
  await b.rpc.prompt("Persist the second transcript");
  const [stateA, stateB] = await Promise.all([a.rpc.request("get_state"), b.rpc.request("get_state")]);
  assert.ok([stateA.sessionFile, stateB.sessionFile].every(existsSync));
  await b.rpc.close();
  await until(() => gone(second.waiterPid) && gone(second.keeperPid), "closed second watcher");
  const rowA = fixture.post("role:alpha-one", "first inbox");
  const rowB = fixture.post("role:alpha-two", "second inbox while it is closed");
  await a.rpc.status(count(1));
  await a.rpc.request("prompt", { message: "/test-reload" });
  const reload = await a.rpc.status(s => count(1)(s) && s.keeperPid !== first.keeperPid);
  assert.equal(reload.cursor, rowA.sequence);
  assert.ok(gone(first.waiterPid) && gone(first.keeperPid));
  // In-process /new ignores the still-present PI_CHATBOARD_MEMBER=one.
  assert.equal((await a.rpc.request("new_session")).cancelled, false);
  const neverInherited = await a.rpc.status(s => s.state === "off");
  assert.notEqual(neverInherited.session, a.id);
  assert.equal(neverInherited.keeperPid, undefined);
  await a.rpc.close();
  const afterQuit = fixture.post("role:alpha-one", "first inbox while closed");
  const changed = join(fixture.root, "changed.json");
  fixture.setProfile({ suppressSelf: true }, changed);
  const invalid = fixture.rpc(undefined, { file: stateA.sessionFile, profilePath: changed });
  const rejected = await invalid.rpc.status(s => s.state === "unavailable" && !s.keeperPid);
  assert.match(rejected.reason, /conflicts/);
  invalid.rpc.assertQuiet();
  await invalid.rpc.close();
  // Bootstrap env is intentionally absent on resume. The stored identity is authoritative.
  const { rpc } = fixture.rpc(undefined, { ...modelOpts, file: stateA.sessionFile });
  await rpc.status(s => count(2)(s) && s.session === a.id && s.cursor === afterQuit.sequence);
  assert.deepEqual((await rpc.command("inbox")).sequences, [rowA.sequence, afterQuit.sequence]);
  const resumeA = await rpc.status(listening);
  assert.equal((await rpc.request("switch_session", { sessionPath: stateB.sessionFile })).cancelled, false);
  const switchB = await rpc.status(s => count(1)(s) && s.session === b.id);
  assert.equal(switchB.member, "two");
  assert.ok(gone(resumeA.waiterPid) && gone(resumeA.keeperPid));
  assert.deepEqual((await rpc.command("inbox")).sequences, [rowB.sequence]);
  const { messages } = await rpc.request("get_fork_messages");
  assert.ok(messages.length);
  assert.equal((await rpc.request("fork", { entryId: messages[0].entryId })).cancelled, false);
  const forked = await rpc.status(s => s.state === "off");
  assert.notEqual(forked.session, b.id);
  assert.ok(gone(switchB.waiterPid) && gone(switchB.keeperPid));
  assert.equal((await rpc.request("new_session")).cancelled, false);
  const fresh = await rpc.status(s => s.state === "off");
  assert.notEqual(fresh.session, forked.session);
  assert.equal(fresh.keeperPid, undefined);
  rpc.assertQuiet();
});

for (const cutWait of [false, true]) {
  test(`actual new_context boundary keeps enrollment (${cutWait ? "waiter interrupted" : "waiter survives"})`,
    { timeout: 40000, skip: !existsSync(epochExtension) && "provide PI_CHATBOARD_EPOCH_EXTENSION" }, async t => {
      const fixture = lab(t);
      const projectSettings = join(fixture.repo, ".pi");
      mkdirSync(projectSettings);
      const settings = JSON.stringify({ compaction: { keepRecentTokens: 12, enabled: false } });
      // Pi uses the isolated agent dir. The installed epoch plugin reads the
      // override independently via the project settings path.
      for (const dir of [fixture.agent, projectSettings]) writeFileSync(join(dir, "settings.json"), settings);
      const { rpc, id } = fixture.rpc("one", { extras: [...fauxArgs, "-e", epochExtension],
        envExtras: { CHATBOARD_MODEL_LAB: fixture.root, CHATBOARD_MODEL_EPOCH: "1" } });
      const first = await rpc.status(listening);
      assert.equal(existsSync(join(fixture.root, "calls")), false);
      await rpc.request("prompt", { message: `Drive the offline new_context tool. ${"Fixture context to retire. ".repeat(32)}` });
      const mark = name => join(fixture.root, name);
      const calls = () => readFileSync(mark("calls"), "utf8").trim().split("\n").length;
      await until(() => existsSync(mark("busy")), "faux model executing tool");
      const busy = fixture.post("role:alpha-one", "untrusted busy text", "--wake");
      await rpc.status(s => s.cursor === busy.sequence);
      assert.equal(calls(), 1);
      assert.equal((await rpc.request("get_state")).pendingMessageCount, 0);
      writeFileSync(mark("busy-release"), "release");
      await until(() => existsSync(mark("settling")), "first agent turn settling");
      assert.equal(calls(), 3);
      if (cutWait) process.kill(first.waiterPid, "SIGKILL");
      const settling = fixture.post("role:alpha-one", "untrusted settling text", "--wake");
      // Release immediately in the interrupted case so reconnect may cross the
      // committed epoch, instead of waiting for recovery first.
      if (!cutWait) await until(() => fixture.hasDurableDelivery(id, settling.sequence), "durable intake while agent_settled is held");
      assert.equal((await rpc.request("get_state")).pendingMessageCount, 0);
      writeFileSync(mark("settling-release"), "release");
      await until(() => calls() >= 4 && rpc.events.filter(e => e.type === "agent_end").length >= 2,
        "native continuation after new_context").catch(e => {
        const notices = rpc.events.filter(e => e.type === "extension_ui_request" && e.method === "notify").map(e => e.message);
        throw new Error(`${e.message}; model calls: ${calls()}; notices: ${JSON.stringify(notices)}`);
      });
      const state = await rpc.request("get_state");
      assert.equal(state.sessionId, id);
      const transcript = readFileSync(state.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const boundaries = transcript.filter(e => e.type === "compaction" && e.details?.kind === "pi-context-epochs/epoch");
      assert.equal(boundaries.length, 1);
      assert.equal(boundaries[0].details.trigger, "model");
      assert.equal(boundaries[0].details.version, 1);
      const after = fixture.post("all", "untrusted after epoch", `--to=session:${id}`, "--wake");
      const rolled = await rpc.status(s => count(3)(s) && s.cursor === after.sequence);
      assert.equal(rolled.keeperPid, first.keeperPid);
      assert.equal(rolled.waiterPid === first.waiterPid, !cutWait);
      assert.deepEqual((await rpc.command("inbox")).sequences, [busy.sequence, settling.sequence, after.sequence]);
      assert.equal((await rpc.request("get_state")).pendingMessageCount, 0);
      assert.equal(calls(), 4);
      assert.equal(rpc.events.filter(e => e.type === "agent_start").length, 2);
      assert.equal(rpc.events.filter(e => e.type === "extension_error").length, 0);
      for (const text of [busy.body, settling.body, after.body]) assert.ok(!JSON.stringify(transcript).includes(text));
    });
}
