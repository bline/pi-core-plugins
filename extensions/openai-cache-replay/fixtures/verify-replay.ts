import assert from "node:assert/strict";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import experiment from "../index.ts";

export default async function () {
	const hooks = new Map();
	const commands = new Map();
	experiment({
		on: (name: string, hook: unknown) => hooks.set(name, hook),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
	} as unknown as ExtensionAPI);

	const base = getBuiltinModels("openai").find((model) => model.api === "openai-responses")!;
	const oauth = { ...base, id: "gpt-6.2-sol", reasoning: true, provider: "openai" } as Model<"openai-responses">;
	const key = { ...oauth, provider: "openai-api" };
	const credentials = { openai: "fake-subscription-token", "openai-api": "sk-fake-key" };
	let report = "";
	const context = (model: Model, subscription = true) => ({
		model,
		modelRegistry: {
			find: (id: string) => id === "openai" ? oauth : key,
			isUsingOAuth: (candidate: Model) => subscription && candidate.provider === "openai",
		},
		ui: { notify: (text: string) => { report = text; } },
	});

	const signed = { type: "reasoning", id: "rs_probe", summary: [], encrypted_content: "opaque-fixture" };
	const secretText = "unique prompt text that must not appear in the report";
	const sessionId = "test-cache-session";
	const capture = async (model: Model<"openai-responses">, messages: TranscriptContext["messages"]) => {
		let payload;
		let authorization;
		let affinityHeader;
		let clientRequestId;
		await openAIResponsesApi().streamSimple(model, { messages }, {
			apiKey: credentials[model.provider as keyof typeof credentials],
			reasoning: "medium",
			cacheRetention: "short",
			sessionId,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				authorization = request.headers.get("authorization");
				affinityHeader = request.headers.get("session-id");
				clientRequestId = request.headers.get("x-client-request-id");
				payload = await request.json();
				return new Response("{}", { status: 400 });
			},
		}).result();
		assert.ok(payload, "Responses adapter did not build a request");
		assert.equal(authorization, `Bearer ${credentials[model.provider as keyof typeof credentials]}`);
		assert.equal(affinityHeader, sessionId, `${model.provider} changed session-id`);
		assert.equal(clientRequestId, sessionId, `${model.provider} changed x-client-request-id`);
		return payload;
	};

	for (const [from, to] of [[oauth, key], [key, oauth]]) {
		hooks.get("session_start")();
		const messages: TranscriptContext["messages"] = [
			{ role: "system", content: "Test system instructions", timestamp: 1 },
			{ role: "user", content: secretText, timestamp: 2 },
			{
				role: "assistant", api: from.api, provider: from.provider, model: from.id, timestamp: 3,
				content: [
					{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(signed) },
					{ type: "text", text: "Answer", textSignature: "msg_probe" },
				],
				stopReason: "stop",
				usage: { input: 2, output: 1, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		];
		const baseRequest = await capture(from, messages);
		const stockCrossover = await capture(to, messages);
		assert.ok(baseRequest.input.some((item: { id?: string }) => item.id === signed.id));
		assert.ok(!stockCrossover.input.some((item: { id?: string }) => item.id === signed.id));

		const edit = hooks.get("context_with_system");
		assert.equal(edit({ messages }, context(to, false)), undefined);
		assert.equal(edit({ messages }, context({ ...to, baseUrl: "https://proxy.invalid/v1" })), undefined);
		assert.equal(edit({ messages }, context({ ...to, provider: "openai-codex" })), undefined);
		const foreign = [{ ...messages[2], model: "other-model" }];
		assert.equal(edit({ messages: foreign }, context(to)), undefined);

		const { messages: replay } = edit({ messages }, context(to));
		assert.equal(messages[2].provider, from.provider, "original history was mutated");
		replay.push({ role: "user", content: "Follow-up", timestamp: 4 });
		const outgoing = await capture(to, replay);
		assert.deepEqual(outgoing.input.slice(0, baseRequest.input.length), baseRequest.input);
		assert.deepEqual(outgoing.input.find((item: { id?: string }) => item.id === signed.id), signed);

		const before = hooks.get("before_provider_request");
		before({ payload: baseRequest }, context(from));
		before({ payload: outgoing }, context(to));
		hooks.get("message_end")({ message: { ...messages[2], provider: to.provider } });
		await commands.get("cache-replay-report").handler("", context(to));
		assert.match(report, /\d+\/\d+ previous items match \(1 signed\); instructions\/tools match; cache key matches/);
		assert.match(report, /cache read 3\/9 input tokens \(4 written\)/);
		assert.ok(!report.includes(secretText) && !report.includes(signed.encrypted_content));
	}
	console.log("OpenAI cache replay checks passed");
}
