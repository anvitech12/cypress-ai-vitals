#!/usr/bin/env bash
# Installs the packed tarball into a fresh project and checks the entry points, types and CLI as a user gets them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT"
TARBALL="$(npm pack --silent --pack-destination "$WORK" | tail -1)"
cd "$WORK"
npm init -y >/dev/null
CYPRESS_INSTALL_BINARY=0 ONNXRUNTIME_NODE_INSTALL=skip npm install --no-audit --no-fund --silent "./$TARBALL" cypress@16 typescript@5 >/dev/null
node --input-type=module -e "await import('@huggingface/transformers')"
echo "The local AI runtime installs with the plugin"
# Simulate an install where the optional runtime was skipped, as on a network that blocks api.nuget.org.
mv node_modules/@huggingface/transformers transformers.skipped
node -e "require('cypress-ai-vitals/plugin'); require('cypress-ai-vitals/providers'); console.log('CommonJS entry points load')"
node --input-type=module -e "await import('cypress-ai-vitals/plugin'); await import('cypress-ai-vitals/providers'); console.log('ES module entry points load')"
for ext in cjs mjs; do
  if [ "$ext" = cjs ]; then load="const { aiVitalsPlugin } = require('cypress-ai-vitals/plugin');"; else load="import { aiVitalsPlugin } from 'cypress-ai-vitals/plugin';"; fi
  cat > "optional.$ext" <<JS
$load
const tasks = {};
aiVitalsPlugin((event, handlers) => { if (event === 'task') Object.assign(tasks, handlers); }, { projectRoot: process.cwd() }, { terminalSummary: false, specReports: false });
const meta = { command: 'aiAssert', spec: 'smoke.cy.ts', test: 'smoke' };
const plain = await tasks['aiVitals:scoreText']({ output: 'Washington, D.C.', spec: { mustMention: ['Washington'] }, meta });
if (!plain.pass) throw new Error('mustMention failed without the local AI runtime');
const local = await tasks['aiVitals:scoreText']({ output: 'Washington, D.C.', spec: { means: 'The capital is Washington, D.C.' }, meta }).catch((err) => err);
if (!String(local?.message).includes('npm i -D @huggingface/transformers')) throw new Error('means did not name the package to install: ' + local);
JS
  if [ "$ext" = cjs ]; then { echo '(async () => {'; cat optional.cjs; echo '})().catch((err) => { console.error(err); process.exit(1); });'; } > optional.tmp && mv optional.tmp optional.cjs; fi
  node "optional.$ext" >/dev/null
done
echo "Without the runtime, plain checks run and local-model checks say how to install it"
mv transformers.skipped node_modules/@huggingface/transformers
test "$(npx cypress-ai-vitals --version)" = "$(node -p "require('cypress-ai-vitals/package.json').version")"
echo "CLI prints its version"
cat > check.ts <<'TS'
import { aiVitalsPlugin } from 'cypress-ai-vitals/plugin';
import { register } from 'cypress-ai-vitals';
register();
export const plugin: typeof aiVitalsPlugin = aiVitalsPlugin;
cy.wrap('Washington, D.C.').aiAssert({ mustMention: ['Washington'] });
TS
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "lib": ["es2022", "dom"], "types": ["cypress"], "noEmit": true, "skipLibCheck": true }, "files": ["check.ts"] }
JSON
npx tsc -p tsconfig.json
echo "Types resolve with TypeScript's default module resolution"
