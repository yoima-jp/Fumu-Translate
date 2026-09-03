import { spawn } from 'node:child_process';

const MAX_CONFIGURATION_BYTES = 1_000_000;
let configurationBuffer = Buffer.alloc(0);
let target = null;

function failStartup() {
  process.stdin.destroy();
  process.exitCode = 1;
}

function startTarget(configuration, remainder) {
  if (
    typeof configuration !== 'object' ||
    configuration === null ||
    typeof configuration.executable !== 'string' ||
    !Array.isArray(configuration.arguments) ||
    !configuration.arguments.every((value) => typeof value === 'string') ||
    typeof configuration.cwd !== 'string' ||
    typeof configuration.environment !== 'object' ||
    configuration.environment === null
  ) {
    failStartup();
    return;
  }

  target = spawn(configuration.executable, configuration.arguments, {
    cwd: configuration.cwd,
    env: configuration.environment,
    detached: false,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  target.stdin.on('error', () => undefined);
  target.stdout.pipe(process.stdout);
  target.stderr.pipe(process.stderr);
  target.once('error', failStartup);
  target.once('close', (code) => {
    process.stdin.unpipe(target.stdin);
    process.stdin.destroy();
    process.exitCode = code ?? 1;
  });

  if (remainder.byteLength > 0) {
    target.stdin.write(remainder);
  }
  process.stdin.pipe(target.stdin);
  process.stdin.resume();
}

function receiveConfiguration(chunk) {
  configurationBuffer = Buffer.concat([configurationBuffer, chunk]);
  if (configurationBuffer.byteLength > MAX_CONFIGURATION_BYTES) {
    process.stdin.off('data', receiveConfiguration);
    failStartup();
    return;
  }

  const lineBreak = configurationBuffer.indexOf(0x0a);
  if (lineBreak < 0) {
    return;
  }

  process.stdin.pause();
  process.stdin.off('data', receiveConfiguration);
  const line = configurationBuffer.subarray(0, lineBreak).toString('utf8');
  const remainder = configurationBuffer.subarray(lineBreak + 1);
  configurationBuffer = Buffer.alloc(0);
  try {
    startTarget(JSON.parse(line), remainder);
  } catch {
    failStartup();
  }
}

// このtrusted helper自身はAgentを生成せず、親がJob Objectへ所属させてから
// configurationを送る。Windowsのspawn→AssignProcessToJobObject競合を閉じる境界である。
process.stdin.on('data', receiveConfiguration);
process.stdin.once('end', () => {
  if (target === null) {
    failStartup();
  }
});
