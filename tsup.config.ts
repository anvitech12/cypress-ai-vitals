import { defineConfig } from 'tsup';

const external = ['cypress', '@huggingface/transformers', '@anthropic-ai/sdk', 'sharp'];

export default defineConfig([
  {
    entry: {
      'support/index': 'src/support/index.ts',
      'plugin/index': 'src/plugin/index.ts',
      'providers/index': 'src/providers/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node22',
    external,
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    external,
  },
]);
