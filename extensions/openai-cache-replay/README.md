# OpenAI signed-reasoning replay experiment

This extension is **not loaded by the root package**. Use it in a fresh, disposable session with non-sensitive prompts. It lets Pi replay existing OpenAI reasoning signatures unchanged when switching between `openai/gpt-6.2-sol` (ChatGPT OAuth) and `openai-api/gpt-6.2-sol` (API-key billing). It only changes the request copy of the conversation; it does not rewrite the session log, change credentials, or re-sign anything. OpenAI may reject replay across credentials.

## Run it once

From the repository root, with the built-in `openai` provider logged in through OAuth and `OPENAI_API_KEY` already set:

```sh
pi --no-extensions \
  -e ./extensions/api-providers/index.ts \
  -e ./extensions/openai-cache-replay/index.ts \
  --model openai/gpt-6.2-sol --thinking medium --no-tools
```

This starts a new session without installing either extension or loading unrelated extensions. If the aliases haven't been refreshed yet, open `/model` online and wait for the catalog refresh. Keep the same thinking level as you switch.

1. **Warm and check OAuth.** Send a long, non-sensitive prompt (a few thousand tokens of sample text) with a task that needs reasoning. Send a short follow-up on the same model. Run `/cache-replay-report` and check that the latest request included signed items and had a cache read. Repeat on OAuth if needed.
2. **Switch to the API key.** Select `openai-api/gpt-6.2-sol` via `/model`, then send a short follow-up. This request uses your API credits. If OpenAI rejects the replay, note the error rather than retrying with different history. If it succeeds, send one more API follow-up as a same-credential control.
3. **Switch back.** Select `openai/gpt-6.2-sol`, send a short follow-up, and run `/cache-replay-report` again.

The report compares each outgoing request with the preceding one. A full match means all previous input items, including any signed items counted in the shared prefix, match at Pi’s request hook. It also checks instructions, tools, and the cache key. The report shows OpenAI’s per-request cache read/write counts, not the content or signature bytes. Comparisons stay in memory; normal Pi session logging still applies. Identical client-side prefixes do not guarantee identical server-side prefixes, cache routing, or cache sharing.

Pi’s OpenAI Responses adapter already sends the same `session-id` and `x-client-request-id` on both routes when you switch models within a session. The offline test checks those headers at the HTTP transport boundary with different mock credentials. The extension does not override either header.
