# Changelog

## 0.2.0 (2026-10-21)

Changes from the Cypress team's review of the plugins-list entry.

**Breaking:**

- **`.env` is no longer read by default.** The plugin reads `ai.env` and real environment variables only, so it never picks up your app's keys from `.env` by accident. To read `.env`, name it: `envFile: '.env'` or `envFile: ['ai.env', '.env']`. If `.env` still holds `AI_*` settings, the plugin and `models` say so.

**Changed:**

- **The local AI runtime, `@huggingface/transformers`, is now an optional dependency.** It still installs with `npm i -D cypress-ai-vitals`. If its install fails, for example on a network that blocks `api.nuget.org`, the plugin's install no longer fails: every other check works, and a check that needs the runtime says how to install it.

**Added:**

- **`aiVitalsAfterSpec(spec, results)`** and the `registerAfterSpec: false` option, for projects with their own `after:spec` handler. The README now says plainly that the plugin's handler replaces one registered before it.
- **`redact` option** for extra values to hide, of any length. A user and password in a URL (`postgres://user:password@host`) are now redacted too.
- **Releases are published from GitHub Actions with npm provenance** (trusted publishing), so each version can be checked against this repository with `npm audit signatures`.
- README sections for **restricted networks** (the `api.nuget.org` download at install and the `huggingface.co` model download) and **your own after:spec**.

## 0.1.1 (2026-10-21)

- **Open report from the panel.** In `cypress open`, a **Report** button opens the spec's full HTML report in a new tab. In `cypress run`, the panel shows the report's file path.
- **Same-site images and audio load in the browser**, so your app's cookies and `cy.intercept` stubs apply. Media on other sites is still loaded by Node.
- **Rate limits:** waits written in minutes ("try again in 1m2s") and the `Retry-After` header are read correctly, so long waits fail fast with the reason instead of retrying too soon.
- **Chinese, Japanese and Thai** speech is scored by character, so one wrong character no longer counts as a whole wrong sentence.
- **no-prompt-leak** no longer flags a polite refusal that mentions "my system prompt"; it looks for disclosed instructions and the canary.
- **Clearer messages:** a missing `aiVitalsPlugin` in `cypress.config` is named in the Command Log, and a broken dataset row names its file and line.
- **CLI:** `--version`; `models --ping` exits 1 when no models are configured; `report --run` with an unknown id fails and lists the runs; a cut-off results line is skipped with a warning.
- **Reports:** numbering past report-999 keeps the newest reports, a spec outside the project keeps its report inside the reports folder, and the panel and the reports compute p95 the same way.
- **Settings:** `AI_MODEL_<NAME>_VOICE=openai:...` style names are models, not settings of another model.
- `sharp` is a direct dependency, so image checks work with pnpm; `aiCompare` shows n/a for a model with nothing scored.
- CI installs the packed package into a fresh project and checks its entry points, types and CLI.

## 0.1.0 (2026-10-20)

First release.

- **Text checks** with `aiAssert`: `means` (local embeddings), `mustMention`, `exactAnswer`, `maxWer`, `groundedIn` (local entailment), `jsonSchema`, `regex`, `refusal`, guardrails (`no-pii`, `no-prompt-leak`, `no-reasoning-leak`) and an optional LLM `judge`.
- **Image checks** with `aiImageAssert`: `depicts` and `notDepicts` (local CLIP), brand palette and style, dimensions and a vision `judge`.
- **Audio checks** with `aiAudioAssert`: transcribe with any listener model or local Whisper, then score word error rate and meaning.
- **AI vitals** with `aiVitals`: latency, tokens in and out, thinking tokens and cost from your app's own requests.
- **Model arena** with `aiCompare`: run a dataset against several models, repeat it, and rank them with confidence intervals and an accuracy vs cost chart.
- **Any model** from `ai.env`, in the order you write them: Cloudflare Workers AI (chat, images, speech, transcription), OpenAI, Anthropic, Gemini, Groq, OpenRouter, Mistral, xAI, Together, Fireworks, Cerebras, Hugging Face (router and free Spaces), Ollama, LM Studio, vLLM, any OpenAI-compatible server, and any HTTP API. Tag models (for example `free`) with `_TAGS`.
- **Reports**: a live panel in the runner, a terminal table after each spec, an HTML report per spec (numbered, with the video and screenshots), and `npx cypress-ai-vitals report` for a whole run with a Markdown job summary.
- **Record and replay** real answers for deterministic CI.
- **Rate limits**: short limits are retried using the provider's hint; spent daily allowances fail fast with the reason.
- **Security**: keys stay in Node, and keys and account ids are redacted from results, reports, recordings and error messages.
- **CLI**: `models [--ping]`, `report`, `clean` and `warm`.
- **Tested in Cypress**: 16 integration tests in `cypress/e2e/` cover text, image, audio, vitals, model calls and the runner panel. They run in Chrome in CI with no API keys.
