import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  minify: false
};

// AT-Grafana ships a single build variant (see ADR-002); MCP is always on and
// all runtime dependencies are pure JS, so everything except `vscode` is
// bundled directly into dist/extension.js.
const context = await esbuild.context({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode']
});

if (watch) {
  await context.watch();
  console.log('Watching extension bundle...');
} else {
  await context.rebuild();
  await context.dispose();
}
