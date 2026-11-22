# Pi Core Plugins

Install this checkout as a single Pi package from the repository root:

```sh
pi install "$PWD"
```

Run `/reload` in an open Pi session to load the plugins.

## Plugins

- [API-key providers](extensions/api-providers/README.md): Adds `openai-api` and `anthropic-api` so you can switch between subscription and API-key billing in the same session.

- [OpenAI cache replay experiment](extensions/openai-cache-replay/README.md) (opt-in with `-e`): Tests signed-reasoning replay and cache hits across OAuth and API-key routes.

Each plugin keeps its entry point, tests, and docs in its own directory under `extensions/`. The root `package.json` lists the entry points Pi loads by default. Run `npm test` with `pi` on your PATH to test the package.
