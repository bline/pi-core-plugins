import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const modelId = "gpt-6.2-sol";
const api = "openai-responses";
const endpoint = "https://api.openai.com/v1";
const isRoute = (provider: string) => provider === "openai" || provider === "openai-api";

function isTarget(model: Model | undefined): model is Model<"openai-responses"> {
	return model?.id === modelId && model.api === api && model.baseUrl === endpoint && isRoute(model.provider);
}

function activeTarget(ctx: ExtensionContext) {
	const { model, modelRegistry } = ctx;
	if (!isTarget(model)) return;
	const oauth = modelRegistry.find("openai", modelId);
	const key = modelRegistry.find("openai-api", modelId);
	if (isTarget(oauth) && isTarget(key) && modelRegistry.isUsingOAuth(oauth) && !modelRegistry.isUsingOAuth(key)) {
		return model;
	}
}

function digest(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isSignedItem(input: unknown) {
	if (!input || typeof input !== "object" || !("type" in input) || input.type !== "reasoning") return false;
	return "encrypted_content" in input && typeof input.encrypted_content === "string" && input.encrypted_content.length > 0;
}

interface Snapshot {
	provider: string;
	items: string[];
	instructionsAndTools: string;
	cacheKey: string;
}

interface RequestReport {
	provider: string;
	details: string;
	result?: string;
}

export default function (pi: ExtensionAPI) {
	let previous: Snapshot | undefined;
	const reports: RequestReport[] = [];

	pi.on("session_start", () => {
		previous = undefined;
		reports.length = 0;
	});

	pi.on("context_with_system", (event, ctx) => {
		const target = activeTarget(ctx);
		if (!target) return;
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "assistant" || message.api !== api || message.model !== modelId ||
				!isRoute(message.provider) || message.provider === target.provider) return message;
			// Only the outgoing copy changes. Pi's normal Responses serializer preserves
			// the encrypted reasoning and replay IDs when these identities match.
			changed = true;
			return { ...message, provider: target.provider };
		});
		if (changed) return { messages };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const target = activeTarget(ctx);
		const payload = event.payload;
		if (!target || !payload || typeof payload !== "object" || !("model" in payload) ||
			payload.model !== modelId || !("input" in payload) || !Array.isArray(payload.input)) return;

		const current: Snapshot = {
			provider: target.provider,
			items: payload.input.map((item) => digest([item])),
			instructionsAndTools: digest([
				"instructions" in payload ? payload.instructions : null,
				"tools" in payload ? payload.tools : null,
			]),
			cacheKey: digest(["prompt_cache_key" in payload ? payload.prompt_cache_key : null]),
		};
		let details = `${current.items.length} input items, ${payload.input.filter(isSignedItem).length} signed`;
		if (previous) {
			let shared = 0;
			while (shared < Math.min(previous.items.length, current.items.length) && previous.items[shared] === current.items[shared]) shared++;
			const sharedSigned = payload.input.slice(0, shared).filter(isSignedItem).length;
			details += `; prefix vs ${previous.provider}: ${shared}/${previous.items.length} previous items match (${sharedSigned} signed)`;
			details += `; instructions/tools ${current.instructionsAndTools === previous.instructionsAndTools ? "match" : "differ"}`;
			details += `; cache key ${current.cacheKey === previous.cacheKey ? "matches" : "differs"}`;
		}
		previous = current;
		reports.push({ provider: current.provider, details });
		if (reports.length > 12) reports.shift();
	});

	pi.on("message_end", ({ message }) => {
		const report = reports.at(-1);
		if (!report || report.result || message.role !== "assistant" || message.api !== api ||
			message.model !== modelId || message.provider !== report.provider) return;
		const { input, cacheRead, cacheWrite } = message.usage;
		report.result = `${message.stopReason}: cache read ${cacheRead}/${input + cacheRead + cacheWrite} input tokens (${cacheWrite} written)`;
	});

	pi.registerCommand("cache-replay-report", {
		description: "Show prefix comparisons and cache usage for the OpenAI replay experiment",
		async handler(_args, ctx) {
			if (!reports.length) {
				ctx.ui.notify(`No requests captured. Use openai/${modelId} with OAuth and openai-api/${modelId} with an API key.`, "info");
				return;
			}
			ctx.ui.notify(reports.map(({ provider, details, result }) =>
				`${provider}: ${details}${result ? `; ${result}` : ""}`).join("\n"), "info");
		},
	});
}
