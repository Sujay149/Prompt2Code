/* eslint-env node */
// @ts-check
'use strict';

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [],
  });

  if (watch) {
    await ctx.watch();
    console.log('[watch] build started');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('[build] complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
