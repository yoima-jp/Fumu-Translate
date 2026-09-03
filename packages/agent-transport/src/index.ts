import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createWindowsProcessTreeGuard, type ProcessTreeGuard } from './windows-process-job';

// Selection capture also needs the same kill-on-close Windows containment as
// configurable agent processes. Exporting only the guard keeps process launch
// policy in each trusted caller while sharing the audited native boundary.
export { createWindowsProcessTreeGuard, type ProcessTreeGuard } from './windows-process-job';

export const MAX_AGENT_ARGUMENTS = 256;
const MAX_ARGUMENT_LENGTH = 32_767;
const MAX_ESCAPED_ARGUMENT_CODE_UNITS = 30_000;
const WRITER_SHUTDOWN_TIMEOUT_MS = 1_250;

const ALLOWED_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'CODEX_HOME',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

/**
 * Agent processes receive only OS/runtime discovery variables. Provider keys,
 * Electron flags, SSH agents, and unrelated application secrets are deliberately
 * excluded even when they exist in Fumu's parent environment.
 */
export function createAgentEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  return environment;
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.includes(sep);
}

function isPortableExecutableWithoutExtension(path: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, 'r');
    const prefix = Buffer.allocUnsafe(2);
    return readSync(descriptor, prefix, 0, 2, 0) === 2 && prefix[0] === 0x4d && prefix[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
  }
}

/**
 * Node 24 no longer launches .cmd/.bat files through spawn(shell:false) on
 * Windows. We never enable a shell for user-configurable commands; instead a
 * bare name is resolved to a native .exe/.com along PATH.
 */
export function resolveAgentExecutable(
  executable: string,
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const normalized = executable.trim();
  if (process.platform !== 'win32') {
    return normalized;
  }

  const extension = extname(normalized).toLowerCase();
  if (extension === '.cmd' || extension === '.bat' || extension === '.ps1') {
    throw new Error('Agent command scripts are not supported; select a native executable.');
  }

  const pathValue = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
  const roots = hasPathSeparator(normalized)
    ? [isAbsolute(normalized) ? '' : cwd]
    : (pathValue ?? '').split(delimiter).map((entry) => entry.replace(/^"|"$/gu, ''));
  const suffixes = extension.length === 0 ? ['.exe', '.com', ''] : [''];

  for (const root of roots) {
    if (root.length === 0 && !isAbsolute(normalized)) {
      continue;
    }
    for (const suffix of suffixes) {
      const candidate = isAbsolute(normalized)
        ? `${normalized}${suffix}`
        : resolve(root, `${normalized}${suffix}`);
      if (!existsSync(candidate)) {
        continue;
      }
      const candidateExtension = extname(candidate).toLowerCase();
      if (
        candidateExtension === '.exe' ||
        candidateExtension === '.com' ||
        (candidateExtension.length === 0 && isPortableExecutableWithoutExtension(candidate))
      ) {
        return candidate;
      }
    }
  }
  throw new Error('A native agent executable could not be resolved.');
}

function validateProcessInput(executable: string, arguments_: readonly string[]): void {
  const normalized = executable.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ARGUMENT_LENGTH ||
    normalized.includes('\0')
  ) {
    throw new Error('The agent executable is invalid.');
  }
  if (arguments_.length > MAX_AGENT_ARGUMENTS) {
    throw new Error('The agent has too many arguments.');
  }
  let escapedArgumentCodeUnits = normalized.length * 2 + 3;
  for (const argument of arguments_) {
    if (argument.length > MAX_ARGUMENT_LENGTH || argument.includes('\0')) {
      throw new Error('An agent argument is invalid.');
    }
    // Windows quoting can approximately double runs of backslashes before a quote.
    // Reserve that worst case plus surrounding quotes, leaving room below the
    // CreateProcess 32,767-code-unit command-line ceiling.
    escapedArgumentCodeUnits += argument.length * 2 + 3;
  }
  if (escapedArgumentCodeUnits > MAX_ESCAPED_ARGUMENT_CODE_UNITS) {
    throw new Error('The combined agent arguments are too large.');
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function windowsAgentBootstrapPath(): string {
  const moduleDirectory =
    typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(moduleDirectory, 'agent-bootstrap.js');
  if (existsSync(bundled)) {
    return bundled;
  }
  const source = resolve(moduleDirectory, 'windows-agent-bootstrap.mjs');
  if (existsSync(source)) {
    return source;
  }
  throw new Error('The trusted Windows agent bootstrap could not be located.');
}

export interface AgentProcessOptions {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

export interface AgentProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error: Error | null;
  }>;
  terminate(): Promise<void>;
}

export function spawnAgentProcess(options: AgentProcessOptions): AgentProcess {
  validateProcessInput(options.executable, options.arguments);
  const environment = createAgentEnvironment(options.environment ?? process.env);
  const executable = resolveAgentExecutable(options.executable, options.cwd, environment);
  const usesWindowsBootstrap = process.platform === 'win32';
  const child = spawn(
    usesWindowsBootstrap ? process.execPath : executable,
    usesWindowsBootstrap ? [windowsAgentBootstrapPath()] : [...options.arguments],
    {
      cwd: options.cwd,
      env: usesWindowsBootstrap
        ? {
            ...environment,
            // Electron executable is reused only for the trusted bootstrap. The
            // configured agent receives the allowlisted environment above without
            // this flag, so it cannot inherit Electron/Node launch controls.
            ELECTRON_RUN_AS_NODE: '1',
          }
        : environment,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  // AgentのstderrをProvider responseとして扱わず、かつPipeのbackpressureで停止させない。
  // Promptや秘密値を含む可能性があるため、内容はLogにもMemoryにも保持しない。
  child.stderr.on('data', () => undefined);

  let processTreeGuard: ProcessTreeGuard | null = null;
  let processEnded = false;
  const exited = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error: Error | null;
  }>((resolve) => {
    const settle = (
      code: number | null,
      signal: NodeJS.Signals | null,
      error: Error | null,
    ): void => {
      if (processEnded) {
        return;
      }
      processEnded = true;
      // Closing the Job Object also removes any descendant that outlived its
      // protocol parent. On POSIX the process group is handled in terminate().
      processTreeGuard?.close();
      processTreeGuard = null;
      resolve({ code, signal, error });
    };
    child.once('exit', (code, signal) => settle(code, signal, null));
    // spawn()は実行ファイルが存在しない場合も同期throwせずerror eventを発火する。
    // ListenerがないとElectron main processまで落ちるため、終了状態として必ず回収する。
    child.once('error', (error) => settle(null, null, error));
  });
  try {
    // The error listener above must exist before native containment is attempted:
    // a failed CreateProcess reports asynchronously even when no PID is available.
    processTreeGuard = createWindowsProcessTreeGuard(child.pid ?? -1);
    if (usesWindowsBootstrap) {
      // Bootstrapはこの設定行を受け取るまでAgentを生成しない。したがってJobへの
      // 所属完了とAgent/即時子プロセス生成の間に競合窓が存在しない。
      child.stdin.write(
        `${JSON.stringify({
          executable,
          arguments: [...options.arguments],
          cwd: options.cwd,
          environment,
        })}\n`,
      );
    }
  } catch (error) {
    child.kill();
    throw error;
  }
  let terminationPromise: Promise<void> | null = null;

  return {
    stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    exited,
    terminate(): Promise<void> {
      if (terminationPromise !== null) {
        return terminationPromise;
      }
      if (processEnded || child.exitCode !== null || child.signalCode !== null) {
        terminationPromise = Promise.resolve();
        return terminationPromise;
      }
      terminationPromise = (async () => {
        child.stdin.end();
        await Promise.race([exited.then(() => undefined), delay(500)]);
        if (child.exitCode === null && child.signalCode === null) {
          if (processTreeGuard !== null) {
            processTreeGuard.close();
            processTreeGuard = null;
          } else if (process.platform !== 'win32' && child.pid !== undefined) {
            try {
              process.kill(-child.pid, 'SIGTERM');
            } catch {
              child.kill();
            }
          } else {
            child.kill();
          }
          await Promise.race([exited.then(() => undefined), delay(500)]);
        }
      })();
      return terminationPromise;
    },
  };
}

interface QueueWaiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: unknown): void;
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: QueueWaiter<T>[] = [];
  #ended = false;
  #failure: unknown = null;

  push(value: T): void {
    if (this.#ended) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#values.push(value);
    } else {
      waiter.resolve({ value, done: false });
    }
  }

  end(): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.#ended) {
      return;
    }
    this.#failure = error;
    this.#ended = true;
    // エラー前にbufferされた断片を後から表示すると、tool実行を検出した後にも
    // 未確定テキストがUIへ漏れる。失敗はbuffer全体に優先させる。
    this.#values.splice(0);
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.#values.length > 0) {
          return { value: this.#values.shift() as T, done: false };
        }
        if (this.#ended) {
          if (this.#failure !== null) {
            throw this.#failure;
          }
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

interface JsonRpcPendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface JsonRpcRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export class JsonLineRpcConnection {
  readonly #process: AgentProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pending = new Map<number, JsonRpcPendingRequest>();
  readonly #notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  readonly #closeListeners = new Set<(error: unknown) => void>();
  readonly #decoder = new TextDecoder();
  readonly #encoder = new TextEncoder();
  #nextId = 1;
  #serverRequestHandler: ServerRequestHandler | null = null;
  #closed = false;
  #failed = false;
  #closePromise: Promise<void> | null = null;

  constructor(process: AgentProcess) {
    this.#process = process;
    this.#writer = process.stdin.getWriter();
    void this.#readLoop();
    void process.exited.then(({ code, signal, error }) => {
      if (!this.#closed) {
        this.#fail(
          error === null
            ? new Error(
                `Agent process exited unexpectedly (${code === null ? (signal ?? 'unknown') : String(code)}).`,
              )
            : new Error('Agent process could not be started.', { cause: error }),
        );
      }
    });
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  get closed(): boolean {
    return this.#closed || this.#failed;
  }

  onClosed(listener: (error: unknown) => void): () => void {
    if (this.#failed) {
      queueMicrotask(() => listener(new Error('Agent connection is closed.')));
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  async request(
    method: string,
    params: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<unknown> {
    if (this.closed) {
      throw new Error('Agent connection is closed.');
    }
    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 30_000;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const abort = (): void => {
        this.#pending.delete(id);
        cleanup();
        reject(new DOMException('Agent request cancelled.', 'AbortError'));
      };
      const cleanup = (): void => {
        if (timeout !== null) {
          clearTimeout(timeout);
        }
        options.signal?.removeEventListener('abort', abort);
      };
      this.#pending.set(id, { resolve, reject, cleanup });
      if (options.signal?.aborted === true) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(
        () => {
          this.#pending.delete(id);
          cleanup();
          reject(new Error(`Agent request timed out: ${method}`));
        },
        Math.min(Math.max(timeoutMs, 100), 600_000),
      );

      void this.#send({ id, method, params }).catch((error: unknown) => {
        if (this.#pending.delete(id)) {
          cleanup();
          reject(error);
        }
        this.#fail(error);
        void this.#process.terminate();
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    try {
      await this.#send(params === undefined ? { method } : { method, params });
    } catch (error) {
      this.#fail(error);
      await this.#process.terminate();
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#fail(new Error('Agent connection closed.'));
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    this.#closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Publish the shared close promise before invoking external process code. This also
    // makes a synchronous re-entrant close() from a test double or future adapter safe.
    void this.#closeResources().then(resolveClose, rejectClose);
    return this.#closePromise;
  }

  async #closeResources(): Promise<void> {
    let termination: Promise<void>;
    try {
      // A full pipe can leave writer.write() pending forever. Start process-tree
      // termination first so shutdown never depends on the peer consuming stdin.
      termination = this.#process.terminate();
    } catch (error) {
      termination = Promise.reject(error);
    }

    const [terminationResult] = await Promise.allSettled([termination, this.#shutdownWriter()]);
    if (terminationResult.status === 'rejected') {
      throw terminationResult.reason;
    }
  }

  async #shutdownWriter(): Promise<void> {
    try {
      // abort() rejects queued writes when the underlying adapter cooperates. The
      // timeout is still required because a broken WritableStream sink may never
      // settle either write() or abort(); process-tree termination remains authoritative.
      const aborted = this.#writer
        .abort(new Error('Agent connection closed.'))
        .catch(() => undefined);
      await Promise.race([aborted, delay(WRITER_SHUTDOWN_TIMEOUT_MS)]);
    } catch {
      // The process boundary above is the cleanup guarantee; writer errors are expected
      // after its pipe is destroyed and must not suppress child termination.
    } finally {
      try {
        this.#writer.releaseLock();
      } catch {
        // A non-conforming sink can keep a write request pending beyond the timeout.
        // The connection is permanently closed, so retaining that unusable lock cannot
        // affect a future RPC session.
      }
    }
  }

  async #send(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.closed) {
      throw new Error('Agent connection is closed.');
    }
    const encoded = this.#encoder.encode(`${JSON.stringify(message)}\n`);
    if (encoded.byteLength > 2_000_000) {
      throw new Error('Agent request is too large.');
    }
    await this.#writer.write(encoded);
  }

  async #readLoop(): Promise<void> {
    const reader = this.#process.stdout.getReader();
    let buffer = '';
    try {
      while (!this.closed) {
        const result = await reader.read();
        buffer += this.#decoder.decode(result.value, { stream: !result.done });
        if (buffer.length > 4_000_000) {
          throw new Error('Agent response line is too large.');
        }
        let lineBreak = buffer.indexOf('\n');
        while (lineBreak >= 0) {
          const line = buffer.slice(0, lineBreak).trim();
          buffer = buffer.slice(lineBreak + 1);
          if (line.length > 0) {
            await this.#handleLine(line);
          }
          lineBreak = buffer.indexOf('\n');
        }
        if (result.done) {
          if (buffer.trim().length > 0) {
            await this.#handleLine(buffer.trim());
          }
          if (!this.closed) {
            throw new Error('Agent output closed unexpectedly.');
          }
          return;
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.#fail(error);
        await this.#process.terminate();
      }
    } finally {
      reader.releaseLock();
    }
  }

  async #handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error('Agent emitted malformed JSON.', { cause: error });
    }
    const message = unknownRecord(parsed);
    if (message === null) {
      throw new Error('Agent emitted a non-object JSON message.');
    }

    if (typeof message.id === 'number' && !('method' in message)) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(message.id);
      pending.cleanup();
      const error = unknownRecord(message.error);
      if (error !== null) {
        const description =
          typeof error.message === 'string' ? error.message.slice(0, 2_048) : 'Agent RPC error.';
        pending.reject(new Error(description));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== 'string') {
      throw new Error('Agent emitted an invalid JSON-RPC message.');
    }
    if (typeof message.id === 'number') {
      await this.#handleServerRequest(message.id, message.method, message.params);
      return;
    }
    const notification = { method: message.method, params: message.params };
    for (const listener of this.#notificationListeners) {
      listener(notification);
    }
  }

  async #handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    try {
      if (this.#serverRequestHandler === null) {
        throw new Error('Client method is not supported.');
      }
      const result = await this.#serverRequestHandler(method, params);
      await this.#send({ id, result });
    } catch (error) {
      await this.#send({
        id,
        error: {
          code: -32_601,
          message: error instanceof Error ? error.message.slice(0, 1_024) : 'Request rejected.',
        },
      });
    }
  }

  #fail(error: unknown): void {
    if (this.#failed) {
      return;
    }
    this.#failed = true;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const listener of this.#closeListeners) {
      listener(error);
    }
    this.#closeListeners.clear();
  }
}
