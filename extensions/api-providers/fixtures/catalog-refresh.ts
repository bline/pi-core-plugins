import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const providers = ["openai-api", "anthropic-api"];
		const endpoints = new Map(providers.map((id) => [
			`/api/models/providers/${id.slice(0, -4)}`,
			ctx.modelRegistry.getProvider(id)!.getModels()[0],
		]));
		const original = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = new URL(String(input));
			assert.equal(url.origin, "https://pi.dev");
			assert.equal(new Headers(init?.headers).has("authorization"), false);
			const model = endpoints.get(url.pathname);
			assert.ok(model, `Unexpected catalog endpoint: ${url.pathname}`);
			return Response.json({ models: [{ ...model, id: "catalog-test-model", contextWindow: 250000 }] }, {
				headers: { "last-modified": new Date("2099-01-01").toUTCString() },
			});
		};
		try {
			const result = await ctx.modelRegistry.refresh({ providers, allowNetwork: true, signal: AbortSignal.timeout(4000) });
			assert.equal(result.aborted, false);
			assert.deepEqual([...result.errors], []);
		} finally {
			globalThis.fetch = original;
		}
	});
}
