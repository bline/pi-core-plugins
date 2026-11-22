import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/faux.ts", import.meta.url));
const epochPath = process.env.PI_PRESSURE_TEST_EPOCH ??
  join(homedir(), ".pi/agent/npm/node_modules/pi-context-epochs/src/index.ts");
const pi = process.env.PI_PRESSURE_TEST_PI ?? "pi";
const faux = process.env.PI_PRESSURE_TEST_FAUX ?? "/snap/pi-coding-agent/current/lib/pi/packages/ai/dist/providers/faux.js";
const sha256 = process.env.PI_PRESSURE_TEST_SHA256 ?? "d5209c61f8d7f8bc185531f316876ce6f5630fdecdef0cdc46e992d0acdeff2a";
const reader = process.env.PI_PRESSURE_TEST_READER ??
  join(homedir(), `.local/state/work-engine/tools/context-status/${sha256}/work-engine-context-status`);
const entryType = "work-engine/context-pressure-projected-v1";

async function until(fn, what, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= end) throw new Error(`timed out: ${what}`);
    await delay(20);
  }
}
const rows = file => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

function lab(t, plan, { epochs = false, badDigest = false, selection = "override" } = {}) {
  const root = mkdtempSync(join(process.env.PI_PRESSURE_TEST_SCRATCH ?? homedir(), ".pi-pressure-test-"));
  const agent = join(root, "agent"), sessions = join(root, "sessions"), project = join(root, ".pi");
  for (const dir of [agent, sessions, project]) mkdirSync(dir, { mode: 0o700 });
  const settings = JSON.stringify({ compaction: { keepRecentTokens: 12, enabled: false } });
  for (const dir of [agent, project]) writeFileSync(join(dir, "settings.json"), settings);
  const profile = join(root, "profile.json"), defaultProfile = join(agent, "context-pressure.json");
  const log = join(root, "calls.jsonl"), children = [];
  const writeProfile = (file, overrides) => writeFileSync(file, JSON.stringify({ version: 1, reader,
    sha256: badDigest ? "0".repeat(64) : sha256, triggerTokens: 125000, bandFloorTokens: 150000, ...overrides
  }), { mode: 0o600 });
  if (selection === "override") writeProfile(profile);
  t.after(async () => {
    await Promise.all(children.map(c => c.close()));
    rmSync(root, { recursive: true, force: true });
  });
  function open(file) {
    const args = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
      "--no-mcp", "--no-approve", "--mode", "rpc", "-e", extension, "-e", fixture,
      ...(epochs ? ["-e", epochPath] : []), "--provider", "faux", "--model", "pressure-fixture",
      "--session-dir", sessions, ...(file ? ["--session", file] : ["--session-id", randomUUID()])];
    const child = spawn(pi, args, { cwd: root, env: {
      PATH: process.env.PATH, HOME: root, LC_ALL: "C.UTF-8", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
      ...(selection !== "default" && { PI_CONTEXT_PRESSURE_PROFILE: profile }),
      PRESSURE_FAUX_MODULE: faux, PRESSURE_FIXTURE_LAB: root,
      PRESSURE_FIXTURE_PLAN: JSON.stringify(plan),
    } });
    const events = [];
    let id = 0, err = "";
    const closed = new Promise(resolve => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.on("error", e => { err += e.message; });
    });
    child.stdin.on("error", e => { err += e.message; });
    child.stderr.on("data", x => { err += String(x); });
    createInterface({ input: child.stdout }).on("line", line => {
      try { events.push(JSON.parse(line)); }
      catch { err += `non-RPC stdout: ${line}\n`; }
    });
    async function request(type, fields = {}) {
      const key = String(++id);
      child.stdin.write(JSON.stringify({ type, id: key, ...fields }) + "\n");
      const r = await until(() => {
        const r = events.find(e => e.type === "response" && e.id === key);
        if (!r && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Pi exited: ${err}`);
        return r;
      }, type);
      assert.equal(r.success, true, `${JSON.stringify(r)} ${err}`);
      return r.data;
    }
    const session = {
      request, events, async status() {
        const cut = events.length;
        await request("prompt", { message: "/context-pressure status" });
        const report = await until(() => events.slice(cut).find(e => e.type === "extension_ui_request" &&
          e.method === "notify" && e.message?.startsWith("{")), "status notification");
        return JSON.parse(report.message);
      },
      async prompt(message, count) {
        await request("prompt", { message });
        await session.settled(count);
      },
      async settled(count) {
        await until(async () => rows(log).length >= count && !(await request("get_state")).isStreaming,
          `settled at ${count} calls`).catch(e => { throw new Error(`${e.message}: ${err}\n${JSON.stringify(rows(log))}`); });
        assert.equal(rows(log).length, count, "no extension-triggered call");
        assert.equal(events.filter(e => e.type === "extension_error").length, 0, err);
      },
      async close() {
        child.stdin.end();
        const watchdog = setTimeout(() => child.kill("SIGKILL"), 4000);
        try { return await closed; }
        finally { clearTimeout(watchdog); }
      },
    };
    children.push(session);
    return session;
  }
  return { open, defaultProfile, profile, writeProfile, state: name => join(root, name), calls: () => rows(log) };
}

test("unset override selects Pi's agent directory; adding the profile and reloading needs no restart", { timeout: 15000 }, async t => {
  const h = lab(t, [{ input: 100000 }], { selection: "default" });
  const a = h.open();
  const disabled = await a.status();
  assert.equal(disabled.level, "disabled");
  assert.equal(disabled.profilePath, h.defaultProfile);
  h.writeProfile(h.defaultProfile);
  assert.equal((await a.status()).level, "disabled", "profile changes take effect on reload");
  await a.request("prompt", { message: "/fixture-reload" });
  assert.equal(h.calls().length, 0, "reload and status do not request inference");
  const reloaded = await a.status();
  assert.equal(reloaded.profilePath, h.defaultProfile);
  assert.equal(reloaded.triggerTokens, 125000);
  await a.prompt("establish first fixture observation", 1);
  assert.equal((await a.status()).level, "normal");
});

test("explicit override takes precedence, and a missing override does not use the default", { timeout: 15000 }, async t => {
  const h = lab(t, [], { selection: "missing_override" });
  h.writeProfile(h.defaultProfile);
  const a = h.open();
  const missing = await a.status();
  assert.equal(missing.level, "unavailable");
  assert.equal(missing.profilePath, h.profile);
  assert.equal(missing.triggerTokens, undefined);
  h.writeProfile(h.profile, { triggerTokens: 130000 });
  await a.request("prompt", { message: "/fixture-reload" });
  const selected = await a.status();
  assert.equal(selected.profilePath, h.profile);
  assert.equal(selected.triggerTokens, 130000);
  assert.equal(h.calls().length, 0);
});

test("actual Pi warns before the next natural tool-loop calls, only on escalation, and dedups on resume", { timeout: 30000 }, async t => {
  const h = lab(t, [100000, 128000, 142000, 106000, 144000, 152000, 154000, 155000].map((input, i) => ({
    input, tool: i === 1 ? "fixture_hold" : i < 6 ? "fixture_step" : undefined,
  })));
  const a = h.open();
  assert.equal((await a.status()).level, "unavailable");
  assert.equal(h.calls().length, 0, "status and startup must not start a call");
  await a.request("prompt", { message: "seven exact offline fixture calls" });
  await until(() => existsSync(h.state("held")), "second tool is held");
  const busy = await a.status();
  assert.equal(busy.level, "planning", JSON.stringify(busy));
  assert.equal(busy.inputTokens, 128000);
  assert.equal(h.calls().length, 2, "no wake while the tool is held");
  writeFileSync(h.state("release"), "release");
  await a.settled(7);
  const calls = h.calls();
  assert.deepEqual(calls.map(c => c.warning.length), [0, 0, 1, 1, 0, 0, 1]);
  for (const call of calls) assert.equal(call.leadingRole, "system");
  assert.match(calls[2].warning[0], /planning threshold reached.*128,000 input tokens/);
  assert.equal(calls[2].toolResults.at(-1), "fixture_hold");
  assert.match(calls[3].warning[0], /approaching.*projects reaching it in about 0\.4 calls/);
  assert.match(calls[6].warning[0], /in the empirical pressure band.*not a model limit or reset deadline/);
  const s = await a.request("get_state");
  const lines = rows(s.sessionFile);
  assert.deepEqual(lines.filter(l => l.customType === entryType).map(l => l.data.level),
    ["planning", "approaching_band", "in_band"]);
  assert.equal(JSON.stringify(lines).includes("[Work Engine context pressure:"), false);
  assert.equal((await a.status()).highestProjected, "in_band");
  assert.equal((await a.close()).code, 0);
  const resumed = h.open(s.sessionFile);
  assert.equal((await resumed.status()).highestProjected, "in_band");
  await resumed.prompt("same active branch", 8);
  assert.deepEqual(h.calls().at(-1).warning, []);
  assert.equal((await resumed.request("new_session")).cancelled, false);
  const fresh = await resumed.status();
  assert.equal(fresh.level, "unavailable");
  assert.equal(fresh.highestProjected, null);
  await resumed.prompt("new session has no observation yet", 9);
  assert.deepEqual(h.calls().at(-1).warning, []);
});

test("real new_context does not carry pressure into its first call and re-arms the new epoch", { timeout: 30000 }, async t => {
  const h = lab(t, [
    { input: 130000, tool: "fixture_step" }, { input: 130000, tool: "new_context" },
    { input: 130000 }, { input: 130000 }, { input: 130000 },
  ], { epochs: true });
  const a = h.open();
  const before = await a.request("get_state");
  await a.prompt(`Exercise the real offline new_context tool. ${"Context to retire. ".repeat(32)}`, 4);
  const after = await a.request("get_state");
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(rows(after.sessionFile).filter(l => l.details?.kind === "pi-context-epochs/epoch").length, 1);
  assert.deepEqual(h.calls().map(c => c.epoch), [0, 0, 0, 1]);
  assert.deepEqual(h.calls().map(c => c.warning.length), [0, 1, 0, 0]);
  assert.equal((await a.status()).highestProjected, null);
  await a.prompt("naturally continue after the first epoch-1 observation", 5);
  assert.match(h.calls().at(-1).warning[0], /planning threshold reached.*Pi epoch 1/);
});

test("wrong digest fails closed for readings but not for ordinary model calls", { timeout: 15000 }, async t => {
  const h = lab(t, [{ input: 155000 }, { input: 155000 }], { badDigest: true });
  const a = h.open();
  await a.prompt("first request", 1);
  await a.prompt("no warnings from an unpinned reader", 2);
  const s = await a.status();
  assert.equal(s.level, "unavailable", JSON.stringify(s));
  assert.match(s.reason, /SHA-256/);
  assert.match(s.lastDeliveryError, /SHA-256/);
  assert.deepEqual(h.calls().map(c => c.warning.length), [0, 0]);
});
