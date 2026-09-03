import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  createAgentEnvironment,
  createWindowsProcessTreeGuard,
  type ProcessTreeGuard,
} from '@fumu/agent-transport';
import type {
  SelectionWorkerMessage,
  SelectionWorkerPort,
  SelectionWorkerRequest,
} from './selection-worker-protocol';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TERMINATION_OBSERVATION_MS = 1_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Adapts a kill-on-close process tree to the former Worker-shaped contract.
 * The trusted bootstrap waits for configuration until after it belongs to the
 * Job Object, closing the Windows spawn/assignment race before native code runs.
 */
export class SelectionProcessPort extends EventEmitter implements SelectionWorkerPort {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exited: Promise<number>;
  #guard: ProcessTreeGuard | null = null;
  #buffer = '';
  #termination: Promise<number> | null = null;
  #ended = false;

  constructor(options: { readonly hangFirstQuery?: boolean } = {}) {
    super();
    const bootstrapPath = join(__dirname, 'agent-bootstrap.js');
    const targetPath = join(__dirname, 'selection-process.js');
    const environment = createAgentEnvironment(process.env);
    const child = spawn(process.execPath, [bootstrapPath], {
      cwd: process.cwd(),
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stderr.on('data', () => undefined);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#consume(chunk));
    this.#exited = new Promise<number>((resolve) => {
      child.once('error', (error) => {
        this.emit('error', error);
      });
      child.once('exit', (code) => {
        this.#ended = true;
        this.#closeGuard();
        const exitCode = code ?? 1;
        this.emit('exit', exitCode);
        resolve(exitCode);
      });
    });

    try {
      this.#guard = createWindowsProcessTreeGuard(child.pid ?? -1);
      child.stdin.write(
        `${JSON.stringify({
          executable: process.execPath,
          arguments: [
            targetPath,
            ...(options.hangFirstQuery === true ? ['--fumu-e2e-hang-first-query'] : []),
          ],
          cwd: process.cwd(),
          environment: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
        })}\n`,
      );
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  postMessage(message: SelectionWorkerRequest): void {
    if (this.#ended || this.#child.stdin.destroyed) {
      throw new Error('Selection process is closed.');
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  unref(): void {
    this.#child.unref();
    for (const stream of [this.#child.stdin, this.#child.stdout, this.#child.stderr]) {
      (stream as typeof stream & { unref?: () => void }).unref?.();
    }
  }

  terminate(): Promise<number> {
    if (this.#termination !== null) {
      return this.#termination;
    }
    // CloseHandle on a KILL_ON_JOB_CLOSE Job synchronously makes process-tree
    // destruction authoritative even when a COM call never returns.
    this.#closeGuard();
    this.#child.stdin.destroy();
    if (!this.#ended) {
      this.#child.kill();
    }
    this.#termination = Promise.race([
      this.#exited,
      delay(TERMINATION_OBSERVATION_MS).then(() => 1),
    ]);
    return this.#termination;
  }

  #closeGuard(): void {
    this.#guard?.close();
    this.#guard = null;
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, 'utf8') > MAX_RESPONSE_BYTES) {
      this.emit('error', new Error('Selection process response exceeded its bound.'));
      void this.terminate();
      return;
    }
    let lineBreak = this.#buffer.indexOf('\n');
    while (lineBreak >= 0) {
      const line = this.#buffer.slice(0, lineBreak).trim();
      this.#buffer = this.#buffer.slice(lineBreak + 1);
      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as SelectionWorkerMessage;
          this.emit('message', message);
        } catch (error) {
          this.emit(
            'error',
            new Error('Selection process emitted malformed JSON.', { cause: error }),
          );
          void this.terminate();
          return;
        }
      }
      lineBreak = this.#buffer.indexOf('\n');
    }
  }
}

export function createSelectionProcessFactory(): () => SelectionWorkerPort {
  let processCount = 0;
  const injectOneHang =
    process.env.FUMU_E2E_SELECTION_HANG === '1' &&
    process.argv.includes('--fumu-e2e-selection-hang');
  return () => {
    const hangFirstQuery = injectOneHang && processCount === 0;
    processCount += 1;
    return new SelectionProcessPort({ hangFirstQuery });
  };
}
