import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// This command intentionally produces personal-use, unsigned artifacts only.
// Do not let credentials or externally selected signing/toolchain directories
// leak into electron-builder or any of its descendants.
const sensitivePrefixes = [
  'AWS_',
  'AZURE_',
  'CERTIFICATE_',
  'CSC_',
  'DIGICERT_',
  'EV_',
  'SIGNTOOL_',
  'SM_',
  'SSL_COM_',
  'WIN_CSC_',
];
const allowedEnvironmentVariables = new Set([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PUBLIC',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);

function isExcludedVariable(key) {
  const normalized = key.toUpperCase();
  return (
    !allowedEnvironmentVariables.has(normalized) ||
    sensitivePrefixes.some((prefix) => normalized.startsWith(prefix)) ||
    /^ELECTRON_BUILDER_.+_DIR$/.test(normalized)
  );
}

const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !isExcludedVariable(key)),
);
environment.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const result = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/electron-builder/out/cli/cli.js'),
    '--win',
    'nsis',
    'portable',
    '--config.forceCodeSigning=false',
  ],
  {
    cwd: resolve(root, 'apps/desktop'),
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
