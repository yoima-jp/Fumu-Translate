import { createRequire } from 'node:module';
import type {
  KeyboardEventData,
  MouseEventData,
  SelectionHookConstructor,
  SelectionHookInstance,
  TextSelectionData,
} from 'selection-hook';
import type { SelectionWorkerMessage, SelectionWorkerRequest } from './selection-worker-protocol';

const require = createRequire(import.meta.url);
const SelectionHook = require('selection-hook') as SelectionHookConstructor;
const MAX_REQUEST_BYTES = 64 * 1024;

let hook: SelectionHookInstance | null = null;
let running = false;
let inputBuffer = '';
let fixtureHangPending = process.argv.includes('--fumu-e2e-hang-first-query');

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function send(message: SelectionWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function cleanup(): void {
  const activeHook = hook;
  hook = null;
  running = false;
  if (activeHook !== null) {
    try {
      activeHook.cleanup();
    } catch {
      // The process boundary remains authoritative. A cleanup failure must not
      // delay exit; closing the parent Job Object removes every native thread.
    }
  }
}

function querySelection(activeHook: SelectionHookInstance): {
  readonly data: TextSelectionData | null;
  readonly errorName: string | null;
} {
  let data: TextSelectionData | null = null;
  let queryErrorName: string | null = null;

  try {
    activeHook.enableClipboard();
    data = activeHook.getCurrentSelection();
  } catch (error) {
    queryErrorName = errorName(error);
  } finally {
    try {
      activeHook.disableClipboard();
    } catch (error) {
      queryErrorName ??= errorName(error);
    }
  }

  return { data, errorName: data === null ? queryErrorName : null };
}

function shutdown(): void {
  process.stdin.pause();
  cleanup();
  process.stdout.end(() => process.exit(0));
}

function handleRequest(message: SelectionWorkerRequest): void {
  if (message.type === 'shutdown') {
    shutdown();
    return;
  }

  const activeHook = hook;
  if (!running || activeHook === null) {
    send({
      type: 'selection-result',
      requestId: message.requestId,
      data: null,
      errorName: 'SelectionProcessNotRunningError',
    });
    return;
  }

  // Native E2E uses one deliberately wedged process to prove that the parent
  // can kill and replace a permanently blocked accessibility provider.
  if (fixtureHangPending) {
    fixtureHangPending = false;
    const gate = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(gate, 0, 0);
  }

  const result = querySelection(activeHook);
  send({
    type: 'selection-result',
    requestId: message.requestId,
    data: result.data,
    errorName: result.errorName,
  });
}

function failProtocol(): void {
  cleanup();
  process.exitCode = 1;
  process.stdin.destroy();
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  inputBuffer += chunk;
  if (Buffer.byteLength(inputBuffer, 'utf8') > MAX_REQUEST_BYTES) {
    failProtocol();
    return;
  }
  let lineBreak = inputBuffer.indexOf('\n');
  while (lineBreak >= 0) {
    const line = inputBuffer.slice(0, lineBreak).trim();
    inputBuffer = inputBuffer.slice(lineBreak + 1);
    if (line.length > 0) {
      try {
        const parsed = JSON.parse(line) as Partial<SelectionWorkerRequest>;
        if (
          parsed.type !== 'shutdown' &&
          (parsed.type !== 'resolve-selection' || !Number.isSafeInteger(parsed.requestId))
        ) {
          throw new Error('Invalid selection request.');
        }
        handleRequest(parsed as SelectionWorkerRequest);
      } catch {
        failProtocol();
        return;
      }
    }
    lineBreak = inputBuffer.indexOf('\n');
  }
});
process.stdin.once('end', shutdown);
process.stdin.once('error', failProtocol);
process.once('exit', cleanup);

try {
  const selectionHook = new SelectionHook();
  hook = selectionHook;

  selectionHook.on('mouse-down', (data: MouseEventData) => {
    send({ type: 'mouse-down', data });
  });
  selectionHook.on('key-down', (data: KeyboardEventData) => {
    send({ type: 'key-down', data });
  });
  selectionHook.on('key-up', (data: KeyboardEventData) => {
    send({ type: 'key-up', data });
  });
  selectionHook.on('error', (error: Error) => {
    send({ type: 'runtime-error', errorName: error.name });
  });

  running = selectionHook.start({
    debug: false,
    enableClipboard: false,
    enableMouseMoveEvent: false,
    // Passive mode keeps selected text out of this process until the user
    // explicitly invokes the global shortcut and the parent sends a query.
    selectionPassiveMode: true,
  });

  if (!running) {
    cleanup();
    send({ type: 'startup-error', errorName: 'SelectionHookStartError' });
  } else {
    send({ type: 'ready' });
  }
} catch (error) {
  cleanup();
  send({ type: 'startup-error', errorName: errorName(error) });
}
