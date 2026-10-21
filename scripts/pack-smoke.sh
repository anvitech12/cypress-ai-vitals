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
CYPRESS_INSTALL_BINARY=0 npm install --no-audit --no-fund --silent "./$TARBALL" cypress@16 typescript@5 >/dev/null
node -e "require('cypress-ai-vitals/plugin'); require('cypress-ai-vitals/providers'); console.log('CommonJS entry points load')"
node --input-type=module -e "await import('cypress-ai-vitals/plugin'); await import('cypress-ai-vitals/providers'); console.log('ES module entry points load')"
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
