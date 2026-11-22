import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReading } from "../reader.ts";

const profile = { triggerTokens: 125000, bandFloorTokens: 150000, leadCalls: 3 };
const binding = { id: "3e4d30ff-17ad-4ebb-bc15-776104657d24", epoch: 4, latestAssistant: "2026-11-22T07:20:00.000Z" };
const topic = `control:session:${binding.id}`;
const event = { kind: "context_pressure", host: "pi", topic, session_id: binding.id, agent_id: null,
  authority: "observation_only", level_basis: "tokens", trigger_tokens: 125000, band_floor_tokens: 150000,
  level: "approaching_band", epoch: 4, input_tokens: 136000, source_line: 200, observed_at: binding.latestAssistant,
  observation_status: "latest_valid_observation", estimated_calls_to_band: 2.7 };
const baseline = event => ({ schema: "manual-context-control-v1", topic, event, next_control_cursor: "opaque" });

test("consume canonical levels and retain the difference between quiet and no sample", () => {
  assert.deepEqual(parseReading(baseline(null), profile, binding), { level: "normal", epoch: 4 });
  assert.equal(parseReading(baseline(event), profile, binding).estimatedCalls, 2.7);
  const empty = { ...event, level: "unavailable", observation_status: "awaiting_first_request_in_epoch" };
  assert.deepEqual(parseReading(baseline(empty), profile, binding), {
    level: "unavailable", reason: "awaiting_first_request_in_epoch", epoch: 4,
  });
});
test("crossed bindings, stale epochs and unsupported observations do not warn", () => {
  for (const extra of [{ session_id: "other" }, { epoch: 3 }, { band_floor_tokens: 149000 },
    { level: "constructor" }, { source_line: 0 }, { observation_status: "historical_observation" }]) {
    assert.throws(() => parseReading(baseline({ ...event, ...extra }), profile, binding));
  }
  assert.equal(parseReading(baseline({ ...event, observed_at: "older" }), profile, binding).level, "unavailable");
});
