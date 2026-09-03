import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');
const { FuseState } = require('@electron/fuses/dist/constants');

const executable = process.argv[2];
if (!executable) {
  throw new Error('Usage: node tools/verify-electron-fuses.mjs <electron-executable>');
}

const wire = await getCurrentFuseWire(resolve(executable));
const expectedEnabled = [
  FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  FuseV1Options.OnlyLoadAppFromAsar,
];
for (const option of expectedEnabled) {
  if (wire[option] !== FuseState.ENABLE) {
    throw new Error(`Required Electron fuse is not enabled: ${FuseV1Options[option]}`);
  }
}

process.stdout.write(
  `${JSON.stringify({
    executable: resolve(executable),
    enabled: expectedEnabled.map((option) => FuseV1Options[option]),
  })}\n`,
);
