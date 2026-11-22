import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";

function apiAlias(source: Provider, envVar: string): Provider {
	const id = `${source.id}-api`;
	const rebind = <T extends { provider: string }>(model: T) => ({ ...model, provider: id });

	return {
		// The host stores refresh data under the alias ID; Pi's refresh callback keeps
		// the upstream provider ID inside the cached catalog. Rebind only on read.
		...source,
		id,
		name: `${source.name} API`,
		getModels: () => source.getModels().map(rebind),
		getAllModels: () => (source.getAllModels?.() ?? source.getModels()).map(rebind),
		auth: {
			apiKey: {
				name: envVar,
				async resolve({ ctx, signal }) {
					const key = (await ctx.env(envVar))?.trim();
					signal.throwIfAborted();
					if (!key) return undefined;
					// Match Pi's distinction between vendor API keys and subscription access tokens.
					if (source.id === "openai" && !key.startsWith("sk-")) return undefined;
					if (source.id === "anthropic" && key.includes("sk-ant-oat")) return undefined;
					return { auth: { apiKey: key }, source: envVar };
				},
			},
		},
	};
}

export default async function (pi: ExtensionAPI) {
	// Use Pi's refreshable built-ins, without reading OAuth state or models.json.
	const catalog = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	for (const [id, envVar] of [
		["openai", "OPENAI_API_KEY"],
		["anthropic", "ANTHROPIC_API_KEY"],
	] as const) {
		const source = catalog.getProvider(id);
		if (!source) throw new Error(`Pi's built-in provider "${id}" is missing`);
		pi.registerProvider(apiAlias(source, envVar));
	}
}
