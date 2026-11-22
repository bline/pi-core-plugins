import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default async function fixture(pi: ExtensionAPI) {
  const { fauxAssistantMessage, fauxProvider, fauxToolCall } =
    await import(pathToFileURL(process.env.PRESSURE_FAUX_MODULE!).href);
  const lab = process.env.PRESSURE_FIXTURE_LAB!;
  const plan = JSON.parse(process.env.PRESSURE_FIXTURE_PLAN!) as { input: number; tool?: string }[];
  const log = join(lab, "calls.jsonl");
  let index = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
  let epoch = -1;
  pi.on("context_with_system", (_event, ctx) => {
    epoch = ctx.sessionManager.getBranch().filter(e => e.type === "compaction").length;
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    // Explicit deterministic normalized usage; it is persisted by real Pi.
    const input = plan[index - 1]?.input ?? 90_000;
    const usage = { ...event.message.usage, input: 0, cacheRead: input - 1000, cacheWrite: 1000,
      output: 16, totalTokens: input + 16 };
    return { message: { ...event.message, usage } };
  });
  const faux = fauxProvider({ tokensPerSecond: 1_000_000, models: [{ id: "pressure-fixture", contextWindow: 1_000_000 }] });
  const response = (context: { messages: { role: string; toolName?: string; content: unknown }[] }) => {
    const { tool } = plan[index] ?? {};
    const rendered = context.messages.flatMap(m =>
      typeof m.content === "string" ? [m.content] : Array.isArray(m.content)
        ? m.content.filter(c => c.type === "text").map(c => String(c.text)) : []);
    appendFileSync(log, JSON.stringify({
      index: index++, epoch, leadingRole: context.messages[0]?.role,
      warning: rendered.filter(s => s.startsWith("[Work Engine context pressure:")),
      toolResults: context.messages.filter(m => m.role === "toolResult").map(m => m.toolName),
    }) + "\n");
    return tool ? fauxAssistantMessage([fauxToolCall(tool, {})], { stopReason: "toolUse" })
      : fauxAssistantMessage("offline fixture response");
  };
  faux.setResponses(Array.from({ length: 30 }, () => response));
  pi.registerProvider(faux.provider);
  pi.registerCommand("fixture-reload", { description: "Rebind the real Pi extension runtime",
    async handler(_args, ctx) { await ctx.reload(); } });
  pi.registerTool({ name: "fixture_step", label: "Fixture step", description: "Drive a natural tool continuation",
    parameters: Type.Object({}), async execute() { return { details: {}, content: [{ type: "text", text: "step" }] }; }
  });
  pi.registerTool({ name: "fixture_hold", label: "Fixture hold", description: "Hold the second tool turn",
    parameters: Type.Object({}), async execute() {
      writeFileSync(join(lab, "held"), "ready");
      for (let i = 0; i < 400; i++) {
        if (existsSync(join(lab, "release"))) return { details: {}, content: [{ type: "text", text: "released" }] };
        await delay(25);
      }
      throw new Error("fixture hold not released");
    }
  });
}
