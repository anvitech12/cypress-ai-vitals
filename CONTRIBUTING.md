# Contributing

Thanks for helping. Bug reports, new providers, new checks and docs fixes are all welcome.

## Set up

```bash
git clone https://github.com/anvitech12/cypress-ai-vitals.git
cd cypress-ai-vitals
npm install
npm test            # unit tests, no network, no keys
npm run typecheck
npm run build
```

`npm run test:ml` also runs the tests that load the local models (about 330 MB on first run).

## Integration tests

`cypress/e2e/` holds real Cypress specs that use the plugin the way a project would. They test a small chat page in `cypress/app/`, with fixture images and audio.

```bash
npm run test:e2e    # builds, then runs every spec in Chrome
```

- No keys needed. Text, image and audio checks run on the local models. Chat answers and token usage are stubbed with `cy.intercept`.
- `models.cy.ts` calls real models (Groq and Gemini). It replays answers recorded in `cypress/fixtures/ai-cassettes/`, so it also runs without keys.
- After you change `models.cy.ts`, record its answers again with your own Groq and Gemini keys. Put the keys in `ai.env` in the repo root, or point `AI_ENV_FILE` at a keys file you already have:

```bash
rm -rf cypress/fixtures/ai-cassettes    # optional: drops recordings for prompts you no longer use
npm run test:e2e:record                 # or: AI_ENV_FILE=~/my-project/ai.env npm run test:e2e:record
```

The recordings hold the model name, the prompt, the answer and token counts. They never hold keys or URLs. Read them before you commit them.

## Try your build in another project

To try your build in a Cypress project, run `npm run pack:local` and install the `.tgz` it creates:

```bash
npm i -D /path/to/cypress-ai-vitals-0.1.0.tgz
```

## Adding a provider or a check

- **Provider:** add a preset in `src/plugin/registry.ts` if the API is OpenAI-compatible. Otherwise add an adapter in `src/providers/` and register it in `src/providers/index.ts`. Normalize usage to `inputTokens`, `outputTokens` and `reasoningTokens`.
- **Check:** built-in checks live in `src/scorers/`. Third-party checks can use `defineScorer` without touching the plugin.

## Pull requests

- Add or update a test in `test/` for every behaviour change. Tests must not call real providers; stub `fetch` instead.
- Keep the README in step with the change.
- Never commit keys. Put them in `ai.env` or in environment variables. `ai.env` is gitignored.
