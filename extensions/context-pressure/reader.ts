import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const rank = { planning: 1, approaching_band: 2, in_band: 3 } as const;
export type Pressure = keyof typeof rank;
export type Profile = {
  reader: string; sha256: string; triggerTokens: number; bandFloorTokens: number; leadCalls: number;
};
export type Binding = { id: string; file: string; epoch: number; latestAssistant?: string };
export type Reading =
  | { level: "normal"; epoch: number }
  | { level: "unavailable"; epoch?: number; reason: string }
  | { level: Pressure; epoch: number; inputTokens: number; sourceLine: number; observedAt: string;
      estimatedCalls: number | null; recordedModel: string | null; observationStatus: string };

export const absolute = (value: unknown): value is string =>
  typeof value === "string" && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
};
export const isPressure = (s: unknown): s is Pressure => typeof s === "string" && Object.hasOwn(rank, s);
export const fingerprint = (s: Pick<Awaited<ReturnType<typeof fileStat>>, "dev" | "ino" | "size" | "ctimeNs" | "mtimeNs">) =>
  [s.dev, s.ino, s.size, s.ctimeNs, s.mtimeNs].join(":");
const fileStat = (path: string) => stat(path, { bigint: true });

export async function loadProfile(path: string): Promise<Profile> {
  if (process.platform !== "linux") throw new Error("requires Linux");
  if (!absolute(path)) throw new Error("PI_CONTEXT_PRESSURE_PROFILE must be an absolute path");
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let p;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384) throw new Error("expected a small regular profile file");
    const data = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== info.size || fingerprint(await handle.stat({ bigint: true })) !==
        fingerprint(await fileStat(path)) || bytesRead > 16384) throw new Error("profile changed during read");
    p = object(JSON.parse(data.subarray(0, bytesRead).toString("utf8")));
  } finally { await handle.close(); }
  const { reader, sha256, triggerTokens, bandFloorTokens, leadCalls = 3 } = p;
  if (p.version !== 1 || Object.keys(p).some(k =>
    !["version", "reader", "sha256", "triggerTokens", "bandFloorTokens", "leadCalls"].includes(k))) {
    throw new Error("unsupported context pressure profile or field");
  }
  if (!absolute(reader) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
    !integer(triggerTokens, 1) || !integer(bandFloorTokens, triggerTokens + 1) || !integer(leadCalls, 0, 1000)) {
    throw new Error("require an absolute reader, lowercase SHA-256, 0 < trigger < band floor, and leadCalls 0..1000");
  }
  return { reader, sha256, triggerTokens, bandFloorTokens, leadCalls };
}

function invoke(fd: number, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // Execute the same open file that was hashed, even if its path is atomically replaced.
    const child = spawn("/proc/self/fd/3", args, {
      cwd: "/", env: { LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", fd],
    });
    const stdout: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const fail = (err: Error) => {
      failure ??= err;
      child.kill("SIGKILL");
    };
    const abort = () => fail(new Error("reader observation canceled"));
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => fail(new Error("context reader timed out")), 2000);
    child.stdout!.on("data", (part: Buffer) => {
      bytes += part.length;
      if (bytes <= 65536) stdout.push(part);
      else fail(new Error("context reader output exceeded 64 KiB"));
    });
    child.stderr!.resume(); // Do not forward transcript-related paths or diagnostics to the model.
    child.once("error", fail);
    child.once("close", code => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new Error("context reader exited unsuccessfully"));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export function parseReading(raw: unknown, p: Profile, b: Binding): Reading {
  const value = object(raw);
  const topic = `control:session:${b.id}`;
  if (value.schema !== "manual-context-control-v1" || value.topic !== topic ||
      typeof value.next_control_cursor !== "string" || !value.next_control_cursor.length) {
    throw new Error("incompatible context reader output");
  }
  // This is a cursor-less baseline. Only a valid normal reading has no event.
  if (value.event === null) return { level: "normal", epoch: b.epoch };
  const e = object(value.event);
  if (e.topic !== topic || e.session_id !== b.id || e.host !== "pi" || e.agent_id !== null ||
      e.kind !== "context_pressure" || e.authority !== "observation_only" || e.level_basis !== "tokens" ||
      e.trigger_tokens !== p.triggerTokens || e.band_floor_tokens !== p.bandFloorTokens) {
    throw new Error("context reader returned a mismatched binding or policy");
  }
  if (e.level === "unavailable" && e.epoch === null) {
    return { level: "unavailable", reason: "reader_could_not_attribute_transcript" };
  }
  if (e.epoch !== b.epoch) throw new Error("reader epoch differs from the live Pi branch");
  if (e.level === "unavailable") return {
    level: "unavailable", epoch: b.epoch,
    reason: e.observation_status === "awaiting_first_request_in_epoch" ? "awaiting_first_request_in_epoch"
      : e.observation_status === "historical_observation" ? "historical_observation" : "no_usable_observation",
  };
  if (!isPressure(e.level) || !integer(e.input_tokens, 1) || !integer(e.source_line, 2) ||
      typeof e.observed_at !== "string" ||
      !["latest_valid_observation", "latest_valid_observation_with_record_gaps"].includes(String(e.observation_status))) {
    throw new Error("context reader did not return a valid pressure observation");
  }
  if (e.observed_at !== b.latestAssistant) {
    return { level: "unavailable", epoch: b.epoch, reason: "reading_is_not_from_latest_live_assistant" };
  }
  return {
    level: e.level, epoch: b.epoch, inputTokens: e.input_tokens, sourceLine: e.source_line,
    observedAt: e.observed_at, recordedModel: typeof e.recorded_model === "string" ? e.recorded_model : null,
    observationStatus: String(e.observation_status),
    estimatedCalls: typeof e.estimated_calls_to_band === "number" && Number.isFinite(e.estimated_calls_to_band) &&
      e.estimated_calls_to_band >= 0 ? e.estimated_calls_to_band : null,
  };
}

export async function observe(p: Profile, b: Binding, signal: AbortSignal): Promise<Reading> {
  const handle = await open(p.reader, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > 32n * 1024n * 1024n) throw new Error("expected a bounded regular reader binary");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ start: 0, end: Number(info.size), autoClose: false })) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    if (hash.digest("hex") !== p.sha256 || fingerprint(info) !== fingerprint(await handle.stat({ bigint: true }))) {
      throw new Error("context reader SHA-256 or file changed");
    }
    const output = await invoke(handle.fd, [
      "control", "--host", "pi", "--session", b.id, "--rollout", b.file,
      "--trigger-tokens", String(p.triggerTokens), "--band-floor-tokens", String(p.bandFloorTokens),
      "--lead-calls", String(p.leadCalls),
    ], signal);
    if (fingerprint(info) !== fingerprint(await handle.stat({ bigint: true }))) {
      throw new Error("context reader file changed during observation");
    }
    return parseReading(JSON.parse(output), p, b);
  } finally { await handle.close(); }
}
