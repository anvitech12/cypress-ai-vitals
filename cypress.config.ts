// The plugin's own integration tests. They run against the built package (npm run build first), and replay
// recorded model answers by default, so CI needs no API keys. Re-record with: npm run test:e2e:record
import { defineConfig } from 'cypress';
import { aiVitalsPlugin } from './dist/plugin/index.js';

export default defineConfig({
  e2e: {
    supportFile: 'cypress/support/e2e.ts',
    video: false,
    setupNodeEvents(on, config) {
      return aiVitalsPlugin(on, config, {
        mode: (process.env.AI_MODE as 'live' | 'record' | 'replay' | undefined) ?? 'replay',
        // Keys come from ai.env, environment variables, or the file AI_ENV_FILE points to.
        envFile: process.env.AI_ENV_FILE,
        judge: 'gemini',
        models: {
          fast: { provider: 'groq', model: 'openai/gpt-oss-20b', price: { inputPerMTok: 0.075, outputPerMTok: 0.3 } },
          gemini: { provider: 'gemini', model: 'gemini-3.5-flash-lite', price: { inputPerMTok: 0.3, outputPerMTok: 2.5 } },
        },
      });
    },
  },
});
