// Packages the app with electron-builder using the four-part release version
// (package.json "releaseVersion", e.g. 2.0.0.1). package.json "version" must stay semver.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const release = pkg.releaseVersion || pkg.version;
const build = release.split('.')[3] ?? '0';
const args = process.argv.slice(2);
if (!args.some((a) => a.startsWith('--win') || a.startsWith('--linux') || a.startsWith('--mac'))) args.unshift('--win');
const result = spawnSync('npx', ['electron-builder', ...args, `--config.extraMetadata.version=${release}`], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, BUILD_NUMBER: process.env.BUILD_NUMBER ?? build }
});
process.exit(result.status ?? 1);
