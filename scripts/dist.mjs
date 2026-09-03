// Packages the app with electron-builder using the four-part release version
// (package.json "releaseVersion", e.g. 2.0.0.1). package.json "version" must stay semver.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const release = pkg.releaseVersion || pkg.version;
const build = release.split('.')[3] ?? '0';
const args = process.argv.slice(2);
if (!args.some((a) => a.startsWith('--win') || a.startsWith('--linux') || a.startsWith('--mac'))) args.unshift('--win');
// The Windows build must embed the Windows native addon (an optional dependency installed only on win32).
if (args.some((a) => a.startsWith('--win')) && !existsSync('node_modules/sherpa-onnx-win-x64/sherpa-onnx.node')) {
  console.error('sherpa-onnx-win-x64 is not installed: build the Windows installer on Windows (npm ci) or install it with\n  npm i --no-save --os=win32 --cpu=x64 sherpa-onnx-win-x64');
  process.exit(1);
}
const result = spawnSync('npx', ['electron-builder', ...args, `--config.extraMetadata.version=${release}`], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, BUILD_NUMBER: process.env.BUILD_NUMBER ?? build }
});
process.exit(result.status ?? 1);
