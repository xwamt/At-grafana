import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  // Watch mode exists to be stepped through in the extension host; the shipped
  // bundle does not. Emitting a map in a production build is worse than
  // useless here: `.vscodeignore` strips `**/*.map`, so the VSIX would carry a
  // `sourceMappingURL` pointing at a file it does not contain.
  sourcemap: watch,
  minify: !watch
};

// AT-Grafana ships a single build variant (see ADR-002); MCP is always on and
// all runtime dependencies are pure JS, so everything except `vscode` is
// bundled directly into dist/extension.js.
//
// Both targets are pinned to the oldest host the manifest claims to support
// (`engines.vscode: ^1.85.0`, which is Electron 25: Node 18 in the extension
// host, Chromium 114 in the Webview). esbuild's default is to assume whatever
// the toolchain can emit, which would happily ship syntax that host cannot
// parse -- a failure that only appears on a user's older VS Code, never here.
const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode']
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/grafana-instance-form/index.ts'],
    outfile: 'dist/webview/grafana-instance-form.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114'
  })
];

const contexts = await Promise.all(contextConfigs);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension and webview bundles...');
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
