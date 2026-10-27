// Builds the release files into dist/: cli.js, a CommonJS bundle whose one
// import from the CLI, eidosmd/plugin, is left for the host to answer, beside
// manifest.yaml and instructions.md as written.
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['eidosmd/plugin'],
  legalComments: 'none',
});
for (const file of ['manifest.yaml', 'instructions.md']) copyFileSync(file, `dist/${file}`);
