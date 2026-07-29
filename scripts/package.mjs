import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const stage = join(root, '.package-work', 'vsix');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

// Everything except `vscode` is esbuild-bundled into dist/extension.js (see
// esbuild.config.mjs), so the packaged manifest ships with zero runtime
// dependencies and vsce does not need a node_modules install step.
const packagedManifest = { ...manifest, dependencies: {} };

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
await access(join(stage, 'dist', 'hub.js'));
await access(join(stage, 'dist', 'hub-version.json'));
await cp(join(root, 'media'), join(stage, 'media'), { recursive: true }).catch(() => {});
await cp(join(root, '.vscodeignore'), join(stage, '.vscodeignore'));
await writeFile(join(stage, 'package.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`, 'utf8');
await cp(join(root, 'README.md'), join(stage, 'README.md'));

const result = spawnSync(
  process.platform === 'win32' ? 'cmd' : 'npx',
  process.platform === 'win32'
    ? [
        '/c',
        'npx',
        '@vscode/vsce',
        'package',
        '--allow-missing-repository',
        '--no-rewrite-relative-links',
        '--no-dependencies'
      ]
    : ['@vscode/vsce', 'package', '--allow-missing-repository', '--no-rewrite-relative-links', '--no-dependencies'],
  { cwd: stage, stdio: 'inherit' }
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const vsixName = `${manifest.name}-${manifest.version}.vsix`;
await cp(join(stage, vsixName), join(root, vsixName));
