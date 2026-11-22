import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { absolute, fingerprint, isPressure, loadProfile, observe, rank } from "./reader.ts";
import type { Binding, Pressure, Profile, Reading } from "./reader.ts";

const ENTRY = "work-engine/context-pressure-projected-v1";
const MESSAGE = "work-engine/context-pressure-v1";
const UUID = /^[0-9a-f]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const titles: Record<Pressure, string> = {
  planning: "planning threshold reached",
  approaching_band: "approaching the empirical pressure band",
  in_band: "in the empirical pressure band",
};

function liveBranch(ctx: ExtensionContext, policy: string) {
  const sm = ctx.sessionManager, id = sm.getSessionId(), file = sm.getSessionFile(), leaf = sm.getLeafId();
  if (!absolute(file) || typeof id !== "string" || !UUID.test(id) || sm.getHeader()?.id !== id) {
    throw new Error("context pressure needs a file-backed Pi session");
  }
  // The reader follows the last appended entry, not a tree selection that has not written to disk.
  if (sm.getEntries().at(-1)?.id !== (leaf ?? undefined)) {
    throw new Error("live tree selection is not the last appended transcript branch");
  }
  let epoch = 0, highest = 0, latestAssistant: string | undefined;
  for (const entry of sm.getBranch()) {
    if (entry.type === "compaction") {
      epoch++;
      highest = 0;
      latestAssistant = undefined;
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      latestAssistant = ["aborted", "error"].includes(entry.message.stopReason) ? undefined : entry.timestamp;
    } else if (entry.type === "custom" && entry.customType === ENTRY) {
      const d = entry.data as { session?: string; policy?: string; level?: unknown } | undefined;
      if (d?.session === id && d.policy === policy && isPressure(d.level)) highest = Math.max(highest, rank[d.level]);
    }
  }
  return { leaf, highest, binding: { id, file, epoch, latestAssistant } satisfies Binding };
}

async function read(ctx: ExtensionContext, p: Profile, policy: string, signal: AbortSignal, status: boolean):
    Promise<{ reading: Reading; highest: number; session: string }> {
  const live = liveBranch(ctx, policy), { binding, leaf, highest } = live;
  const result = (reading: Reading) => ({ reading, highest, session: binding.id });
  // Nothing new since the boundary, or the newest request failed. On demand the
  // reader can distinguish those states from a historical measurement.
  if (!status && !binding.latestAssistant) {
    return result({ level: "unavailable", epoch: binding.epoch, reason: "no_usable_latest_assistant" });
  }
  const fileStat = () => stat(binding.file, { bigint: true });
  let before;
  try { before = await fileStat(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || binding.latestAssistant) throw error;
    return result({ level: "unavailable", epoch: binding.epoch, reason: "session_file_not_yet_materialized" });
  }
  if (!before.isFile()) throw new Error("Pi transcript is not a regular file");
  const reading = await observe(p, binding, signal);
  if (fingerprint(before) !== fingerprint(await fileStat()) || ctx.sessionManager.getLeafId() !== leaf ||
      ctx.sessionManager.getSessionId() !== binding.id || ctx.sessionManager.getSessionFile() !== binding.file) {
    throw new Error("live Pi transcript changed during observation");
  }
  signal.throwIfAborted();
  return result(reading);
}

export default function contextPressure(pi: ExtensionAPI) {
  const override = process.env.PI_CONTEXT_PRESSURE_PROFILE;
  const profilePath = override ?? join(getAgentDir(), "context-pressure.json");
  const runtime = new AbortController();
  let profile: Profile | undefined;
  let profileError: string | undefined;
  let lastDeliveryError: string | undefined;
  pi.on("session_start", async () => {
    try { profile = await loadProfile(profilePath); }
    catch (e) {
      if (override === undefined && (e as NodeJS.ErrnoException).code === "ENOENT") return;
      profileError = e instanceof Error ? e.message : "profile load failed";
    }
  });
  pi.on("session_shutdown", () => runtime.abort());

  const policy = (p: Profile) => [p.sha256, p.triggerTokens, p.bandFloorTokens, p.leadCalls].join(":");

  pi.registerCommand("context-pressure", {
    description: "Show the pinned Work Engine context pressure observation for this Pi session",
    async handler(args, ctx) {
      if (args.trim() && args.trim() !== "status") {
        ctx.ui.notify("Usage: /context-pressure [status]", "info");
        return;
      }
      let reading: Reading | { level: "disabled"; reason: string };
      let highest = 0;
      const p = profile;
      if (!p) {
        reading = profileError ? { level: "unavailable", reason: profileError }
          : { level: "disabled", reason: "default profile not found" };
      } else {
        try {
          ({ reading, highest } = await read(ctx, p, policy(p), runtime.signal, true));
        } catch (e) {
          reading = { level: "unavailable", reason: e instanceof Error ? e.message : "reader failed" };
        }
      }
      ctx.ui.notify(JSON.stringify({
        ...reading, ...p && { triggerTokens: p.triggerTokens, bandFloorTokens: p.bandFloorTokens, leadCalls: p.leadCalls },
        profilePath,
        highestProjected: Object.keys(rank).find(k => rank[k as Pressure] === highest) ?? null,
        lastDeliveryError: lastDeliveryError ?? null,
      }), reading.level === "unavailable" ? "warning" : "info");
    },
  });

  // Unlike before_agent_start, this runs for the next call in a busy tool loop
  // as well. It projects only into a request that Pi was already going to make.
  pi.on("context", async (event, ctx) => {
    const p = profile;
    if (!p || runtime.signal.aborted) return;
    const key = policy(p);
    try {
      const { reading, highest, session } = await read(ctx, p, key, runtime.signal, false);
      lastDeliveryError = undefined;
      if (!isPressure(reading.level)) return;
      if (rank[reading.level] <= highest) return;
      const forecast = reading.level === "approaching_band" && reading.estimatedCalls !== null
        ? ` Recent growth projects reaching it in about ${reading.estimatedCalls.toFixed(1)} calls.` : "";
      const content = `[Work Engine context pressure: ${titles[reading.level]}] ${reading.inputTokens.toLocaleString("en-US")} input tokens; ` +
        `Pi epoch ${reading.epoch}; empirical band starts at ${p.bandFloorTokens.toLocaleString("en-US")}.${forecast} ` +
        "This is an observation, not a model limit or reset deadline. Reassess remaining work and preserve essential continuation state if needed.";
      // The non-LLM entry remembers a projection across reload/resume. The text
      // itself is transient, never persisted as a message or used to trigger a turn.
      pi.appendEntry(ENTRY, { session, policy: key, level: reading.level, sourceLine: reading.sourceLine });
      return { messages: [...event.messages, { role: "custom", customType: MESSAGE, content, display: false,
        timestamp: Date.now() }] };
    } catch (e) {
      lastDeliveryError = e instanceof Error ? e.message : "reader or projection failed";
    }
  });
}
