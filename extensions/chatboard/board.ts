import { execFile } from "node:child_process";
import { integer, MAX_FRAME, object, verifyBoard, type Profile } from "./bindings.ts";

export type Row = Record<string, unknown> & { sequence: number; message_id: string; body: string };
export type Delivery = { row: Row; matchedBy: ("topic" | "to")[] };
export type Batch = { cursor: number; rows: Delivery[]; status: "timeout" | "messages"; hasMore: boolean };

export function row(value: unknown): Row {
  const r = object(value);
  if (!integer(r.sequence, 1) || typeof r.message_id !== "string" || !r.message_id
    || typeof r.body !== "string") throw new Error("invalid board row");
  return r as Row;
}

export function decodeBatch(value: unknown, topics: string[], exclude: string | null): Batch {
  const b = object(value);
  if (b.status !== "timeout" && b.status !== "messages") throw new Error("unexpected messaging-only wait status");
  if (!integer(b.next_since) || !Array.isArray(b.messages) || b.messages.length > 1
    || typeof b.has_more !== "boolean" || (b.status === "messages") !== (b.messages.length === 1)
    || b.exclude_session_id !== exclude || JSON.stringify(b.topics) !== JSON.stringify(topics)
    || b.topic !== null || "control_events" in b || "budget_events" in b) {
    throw new Error("invalid or cross-bound board batch");
  }
  const rows = b.messages.map((entry): Delivery => {
    const r = row(entry);
    if (r.sequence > (b.next_since as number)) throw new Error("message ahead of board cursor");
    if (b.matches === undefined) return { row: r, matchedBy: ["topic"] };
    if (!Array.isArray(b.matches) || b.matches.length !== 1) throw new Error("invalid match provenance");
    const m = object(b.matches[0]);
    const paths = m.matched_by;
    if (m.sequence !== r.sequence || !Array.isArray(paths) || !paths.includes("to") || paths.length > 2
      || new Set(paths).size !== paths.length || paths.some(x => x !== "to" && x !== "topic")) {
      throw new Error("invalid match provenance");
    }
    return { row: r, matchedBy: paths };
  });
  if (b.has_more && rows.length && rows[0].row.sequence !== b.next_since) throw new Error("invalid partial page");
  return { cursor: b.next_since, rows, status: b.status, hasMore: b.has_more };
}

export function boardCall(p: Profile, args: string[], timeout = 6000): Promise<unknown> {
  verifyBoard(p);
  return new Promise((resolve, reject) => {
    execFile(p.python, ["-I", "-B", p.script, "--repository", p.common, ...args],
      { env: p.env, cwd: "/", timeout, maxBuffer: MAX_FRAME, encoding: "utf8" },
      (error, stdout) => {
        // Python/Git errors can include caller text. Don't broadcast stderr into Pi.
        if (error) { reject(new Error("board command failed or its acknowledgement was lost")); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error("board JSON acknowledgement unavailable")); }
      });
  });
}
export type BoardCall = (args: string[], timeout?: number) => Promise<unknown>;

export function readRows(view: unknown): Row[] {
  const result = object(view);
  if (!Array.isArray(result.messages)) throw new Error("invalid board read");
  return result.messages.map(row);
}
export async function boardTail(call: BoardCall): Promise<number> {
  const rows = readRows(await call(["read", "--limit", "1"]));
  if (rows.length > 1) throw new Error("invalid board tail");
  return rows[0]?.sequence ?? 0;
}
