import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default async function fixture(pi: ExtensionAPI) {
  // Snap's extension-facing @pi-ai module does not export the test-only faux provider.
  const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(pathToFileURL(process.env.CHATBOARD_MODEL_MODULE!).href);
  const lab = process.env.CHATBOARD_MODEL_LAB!;
  const blocking = process.env.CHATBOARD_MODEL_EPOCH === "1";
  const handoff = JSON.parse(process.env.CHATBOARD_HANDOFF_TEST ?? "null") as
    { send?: { targets: string[]; body: string }[]; hold?: boolean } | null;
  const log = join(lab, "calls");
  const faux = fauxProvider({ tokensPerSecond: 1_000_000, models: [{ id: "chatboard-fixture" }] });
  let calls = 0;
  let sequences: number[] = [];
  let handoffStep = 0;
  if (handoff) pi.on("before_agent_start", event => {
    const msg = event.messageType === "custom" ? event.message : undefined;
    if (msg?.customType !== "pi-chatboard/handoff-v1" || typeof msg.content !== "string") return;
    sequences = [...msg.content.matchAll(/#(\d+)/g)].map(m => Number(m[1]));
    handoffStep = 0;
  });
  const tools = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
  const response = (context: { messages: { role: string; toolName?: string; content: unknown }[] }) => {
    const index = calls++;
    appendFileSync(log, `${index}\n`);
    if (blocking && index < 2) return tools(fauxToolCall(index ? "new_context" : "test_hold", {}));
    if (handoff?.send && index === 0) return tools(fauxToolCall("chatboard", { action: "tell", messages: handoff.send }));
    if (sequences.length) {
      if (handoffStep++ === 0) return tools(...sequences.map(sequence => fauxToolCall("chatboard", { action: "show", sequence })));
      if (handoffStep === 2) {
        const results = context.messages.filter(msg => msg.role === "toolResult" && msg.toolName === "chatboard").slice(-sequences.length);
        const read = results.map(r => {
          const p = JSON.parse((r.content as { text: string }[])[0].text);
          return JSON.parse(p.jsonFragment).row.body;
        });
        sequences = [];
        return tools(fauxToolCall("chatboard", { action: "report", body: `read: ${JSON.stringify(read)}` }));
      }
    }
    if (handoff?.hold && index === 0) return tools(fauxToolCall("test_hold", {}));
    return fauxAssistantMessage("offline fixture response");
  };
  faux.setResponses(Array.from({ length: 20 }, () => response));
  pi.registerProvider(faux.provider);
  pi.registerCommand("test-reload", { description: "Reload the real Pi extension runtime", async handler(_args, ctx) { await ctx.reload(); } });
  if (!blocking && !handoff?.hold) return;

  const barrier = async (name: string) => {
    writeFileSync(join(lab, name), "ready");
    for (let i = 0; i < 600; i++) {
      if (existsSync(join(lab, `${name}-release`))) return;
      await delay(25);
    }
    throw new Error(`fixture barrier ${name} timed out`);
  };
  pi.registerTool({ name: "test_hold", label: "Fixture hold", description: "Pause for a test barrier", parameters: Type.Object({}),
    async execute() {
      await barrier("busy");
      return { details: {}, content: [{ type: "text", text: "released" }] };
    },
  });
  let settled = false;
  pi.on("agent_settled", async () => {
    if (settled) return;
    settled = true;
    await barrier("settling");
  });
}
