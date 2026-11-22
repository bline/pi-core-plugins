import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("./index.ts", import.meta.url));

function createAgentDir(t, credentials = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-api-providers-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials));
	return agentDir;
}

function runPi(agentDir, envOverrides, args, input) {
	return execFileSync("pi", ["--offline", "--no-extensions", "-e", extension, ...args], {
		cwd: agentDir,
		input,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			OPENAI_API_KEY: "",
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_AUTH_TOKEN: "",
			ANTHROPIC_OAUTH_TOKEN: "",
			...envOverrides,
		},
		encoding: "utf8",
		timeout: 10000,
	});
}

function listModels(t, credentials, envOverrides) {
	const output = runPi(createAgentDir(t, credentials), envOverrides, ["--list-models"]);
	return output.trim().split("\n").map((line) => line.trim().split(/\s+/));
}

function catalog(rows, provider) {
	return rows.filter(([id]) => id === provider).map(([, ...model]) => model);
}

test("aliases mirror the built-in API chat catalogs", (t) => {
	const rows = listModels(t, {}, {
		OPENAI_API_KEY: "sk-test-openai",
		ANTHROPIC_API_KEY: "sk-ant-api-test",
	});

	for (const provider of ["openai", "anthropic"]) {
		const builtin = catalog(rows, provider);
		assert.ok(builtin.length > 0, `${provider} did not load`);
		assert.deepEqual(catalog(rows, `${provider}-api`), builtin);
	}
});

test("aliases stay unavailable with stored keys or Anthropic bearer tokens but no API-key env vars", (t) => {
	const rows = listModels(t, {
		openai: { type: "api_key", key: "sk-test-stored-openai" },
		anthropic: { type: "api_key", key: "sk-ant-api-test-stored" },
		"openai-api": { type: "api_key", key: "sk-test-stored-alias" },
		"anthropic-api": { type: "api_key", key: "sk-ant-api-test-stored-alias" },
	}, {
		ANTHROPIC_AUTH_TOKEN: "test-bearer",
		ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-test",
	});

	for (const provider of ["openai", "anthropic"]) {
		assert.ok(catalog(rows, provider).length > 0, `${provider} did not load`);
		assert.deepEqual(catalog(rows, `${provider}-api`), []);
	}
});

test("aliases coexist with existing OAuth logins", (t) => {
	const expires = Date.now() + 60 * 60 * 1000;
	const rows = listModels(t, {
		openai: { type: "oauth", access: "test-openai-oauth", refresh: "unused", expires },
		anthropic: { type: "oauth", access: "sk-ant-oat-test", refresh: "unused", expires },
	}, {
		OPENAI_API_KEY: "sk-test-openai",
		ANTHROPIC_API_KEY: "sk-ant-api-test",
	});

	for (const provider of ["openai", "anthropic", "openai-api", "anthropic-api"]) {
		assert.ok(catalog(rows, provider).length > 0, `${provider} did not load`);
	}
});

test("subscription tokens do not enable the aliases even in API-key variables", (t) => {
	const rows = listModels(t, {}, {
		OPENAI_API_KEY: "test-openai-oauth",
		ANTHROPIC_API_KEY: "sk-ant-oat-test",
	});
	assert.deepEqual(catalog(rows, "openai-api"), []);
	assert.deepEqual(catalog(rows, "anthropic-api"), []);
});

test("aliases refresh from Pi's public catalogs and keep the results offline", (t) => {
	const agentDir = createAgentDir(t);
	const probe = fileURLToPath(new URL("./fixtures/catalog-refresh.ts", import.meta.url));
	const keys = { OPENAI_API_KEY: "sk-test-openai", ANTHROPIC_API_KEY: "sk-ant-api-test" };
	const output = runPi(agentDir, keys, ["-e", probe, "--mode", "rpc", "--no-session"],
		'{"id":"catalog","type":"get_available_models"}\n');
	const events = output.trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(events.filter((event) => event.type === "extension_error"), []);
	const response = events.find((event) => event.id === "catalog");
	assert.equal(response?.success, true, output);

	const offline = runPi(agentDir, keys, ["--list-models"]).trim().split("\n")
		.map((line) => line.trim().split(/\s+/));
	for (const provider of ["openai-api", "anthropic-api"]) {
		const model = response.data.models.find((model) => model.provider === provider && model.id === "catalog-test-model");
		assert.equal(model?.contextWindow, 250000);
		assert.ok(catalog(offline, provider).some(([id]) => id === "catalog-test-model"));
	}
});
