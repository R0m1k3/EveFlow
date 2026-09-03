// Bundles the Electron main and preload scripts into single CommonJS files.
// The preload runs in a sandboxed renderer where `require()` of local modules is forbidden,
// so everything it imports must be inlined.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist-electron', { recursive: true, force: true });

await build({
  entryPoints: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
    'voice-worker': 'electron/voice/worker.ts'
  },
  outdir: 'dist-electron',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // sherpa-onnx-node stays external: it is a native addon shipped unpacked from the asar.
  external: ['electron', 'sherpa-onnx-node'],
  sourcemap: false,
  logLevel: 'info'
});
