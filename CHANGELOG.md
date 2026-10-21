# Changelog

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
