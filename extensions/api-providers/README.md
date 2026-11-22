# API-key providers

This extension adds two choices to Pi without changing the built-in providers or your existing logins:

| Provider | Environment variable |
| --- | --- |
| `openai-api` | `OPENAI_API_KEY` |
| `anthropic-api` | `ANTHROPIC_API_KEY` |

Set the keys in the environment that launches Pi. To try just this extension, run from the repository root:

```sh
pi -e ./extensions/api-providers/index.ts
```

You can also [install the whole package](../../README.md). Once loaded, use `/model` to switch between your existing models and the API-key choices in the same session. Each API-key provider appears when its corresponding key is available, and requests through it are billed to that key.

The aliases use Pi’s bundled model metadata and refresh from the same public pi.dev catalog as the built-in providers. After loading or reloading the extension, open `/model` online and let Pi finish refreshing. Pi caches the refreshed catalogs for offline use and falls back to bundled models if there’s no cache. The catalog refresh does not send your API keys to pi.dev or check which models your key can access.

Verified with Pi 1.5.2. Run `npm test` from the repository root for offline smoke tests; no real keys are needed.
