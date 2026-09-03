import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const nodeGypCli = require.resolve('node-gyp/bin/node-gyp.js');
const selectionHookDirectory = dirname(require.resolve('selection-hook'));

// node-gyp-build would prefer the package's unpatched prebuild. Invoke node-gyp
// directly so every install compiles the reviewed source patch without relying
// on npm's deprecated build-from-source environment config.
const child = spawn(process.execPath, [nodeGypCli, 'rebuild'], {
  cwd: selectionHookDirectory,
  env: process.env,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error('selection-hook rebuild could not start:', error.message);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (code === 0) {
    return;
  }
  console.error(
    `selection-hook rebuild failed (${code === null ? (signal ?? 'unknown') : String(code)}).`,
  );
  process.exitCode = 1;
});
