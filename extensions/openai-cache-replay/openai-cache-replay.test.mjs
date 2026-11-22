import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("OpenAI's Responses adapter preserves the outgoing prefix and session ID in both directions", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-openai-cache-replay-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const probe = fileURLToPath(new URL("./fixtures/verify-replay.ts", import.meta.url));
	const { PATH, HOME } = process.env;
	const output = execFileSync("pi", ["--offline", "--no-extensions", "-e", probe, "--list-models"], {
		cwd: agentDir,
		env: { PATH, HOME, PI_CODING_AGENT_DIR: agentDir },
		encoding: "utf8",
		timeout: 10000,
	});
	assert.match(output, /OpenAI cache replay checks passed/);
});
