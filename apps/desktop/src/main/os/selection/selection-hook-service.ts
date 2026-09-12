import log from 'electron-log/main';
import type { MouseEventData, TextSelectionData } from 'selection-hook';
import type {
  Point,
  ResolvedSelection,
  SelectionAnchor,
  SelectionMethod,
} from '../../../shared/contracts';
import type { SelectionWorkerMessage, SelectionWorkerPort } from './selection-worker-protocol';
import { createSelectionProcessFactory } from './selection-process-port';

// Keep the Main Process free of the native addon. These are stable public
// selection-hook protocol constants; only the killable child loads the DLL.
const INVALID_COORDINATE = -99_999;
const SELECTION_METHOD_UIA = 1;
const SELECTION_METHOD_ACCESSIBLE = 3;
const SELECTION_METHOD_CLIPBOARD = 99;
const POSITION_LEVEL_SELECTION_FULL = 3;

export type MouseDownListener = (point: Point) => void;

export interface SelectionHookServiceOptions {
  readonly queryTimeoutMs?: number;
  readonly hungWorkerRetireMs?: number;
  readonly startupTimeoutMs?: number;
  readonly workerTerminationTimeoutMs?: number;
  readonly maxCodePoints?: number;
  readonly now?: () => number;
  readonly workerFactory?: () => SelectionWorkerPort;
}

export class SelectionTextTooLargeError extends Error {
  constructor(readonly maximum: number) {
    super('Selected text exceeds ' + maximum + ' Unicode code points.');
    this.name = 'SelectionTextTooLargeError';
  }
}

interface PendingQuery {
  readonly resolve: (data: TextSelectionData | null) => void;
  readonly timeout: NodeJS.Timeout;
}

interface PendingStartup {
  readonly worker: SelectionWorkerPort;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export class SelectionHookService {
  readonly #logger = log.scope('selection');
  readonly #queryTimeoutMs: number;
  readonly #hungWorkerRetireMs: number;
  readonly #startupTimeoutMs: number;
  readonly #workerTerminationTimeoutMs: number;
  readonly #maxCodePoints: number;
  readonly #now: () => number;
  readonly #workerFactory: () => SelectionWorkerPort;
  readonly #mouseDownListeners = new Set<MouseDownListener>();
  readonly #pendingQueries = new Map<number, PendingQuery>();
  readonly #timedOutQueryRetireTimers = new Map<number, NodeJS.Timeout>();
  readonly #retiredWorkerTerminations = new Set<Promise<void>>();
  readonly #retiredWorkerErrors: unknown[] = [];

  #worker: SelectionWorkerPort | null = null;
  #startup: PendingStartup | null = null;
  #startPromise: Promise<void> | null = null;
  #running = false;
  #workerResponsive = false;
  #shouldRun = false;
  #nextRequestId = 1;
  #selectionQuery: Promise<TextSelectionData | null> | null = null;
  #stopPromise: Promise<void> | null = null;

  constructor(options: SelectionHookServiceOptions = {}) {
    // UIA初回接続とコピー前の物理キー解放待ちを許容する。
    // 永久停止は子プロセスの退役で回復し、Mainのイベントループは塞がない。
    this.#queryTimeoutMs = options.queryTimeoutMs ?? 5_000;
    this.#hungWorkerRetireMs = options.hungWorkerRetireMs ?? 5_000;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
    this.#workerTerminationTimeoutMs = options.workerTerminationTimeoutMs ?? 1_500;
    this.#maxCodePoints = options.maxCodePoints ?? 100_000;
    this.#now = options.now ?? Date.now;
    this.#workerFactory = options.workerFactory ?? createSelectionProcessFactory();
  }

  get isRunning(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    this.#shouldRun = true;
    if (this.#running) {
      return;
    }

    if (this.#startPromise !== null) {
      await this.#startPromise;
      return;
    }

    const startPromise = this.#startWorker();
    this.#startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.#startPromise === startPromise) {
        this.#startPromise = null;
      }
    }
  }

  recentAnchor(): SelectionAnchor | null {
    // Passive mode does not observe selection text or rectangles between hotkeys.
    // PopupWindowManager therefore starts at the current caret/mouse and moves to
    // the selection rectangle only after the explicit query has completed.
    return null;
  }

  async resolveSelection(): Promise<ResolvedSelection | null> {
    if (!this.#running || this.#worker === null) {
      return null;
    }

    // UIA/MSAAにはキー解放は不要。コピーの注入時だけNative側で実際の
    // キー状態を確認するため、IPCイベントの遅延・欠落でも取得を中断しない。
    let data: TextSelectionData | null;
    try {
      data = await this.#requestSelection();
    } catch (error) {
      this.#logger.warn('Worker selection query failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return null;
    }

    if (data === null) {
      this.#logger.info('Selection query returned no text');
      return null;
    }
    return this.#toResolvedSelection(data);
  }

  onMouseDown(listener: MouseDownListener): () => void {
    this.#mouseDownListeners.add(listener);
    return () => {
      this.#mouseDownListeners.delete(listener);
    };
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== null) {
      return this.#stopPromise;
    }
    const stopping = this.#stopResources();
    this.#stopPromise = stopping;
    void stopping
      .finally(() => {
        if (this.#stopPromise === stopping) {
          this.#stopPromise = null;
        }
      })
      .catch(() => undefined);
    return stopping;
  }

  async #stopResources(): Promise<void> {
    this.#shouldRun = false;
    this.#running = false;
    this.#workerResponsive = false;
    this.#selectionQuery = null;
    this.#failPendingQueries();
    this.#clearRetireTimers();

    const startup = this.#startup;
    this.#startup = null;
    if (startup !== null) {
      clearTimeout(startup.timeout);
      startup.reject(new Error('Selection worker stopped during startup.'));
    }

    const worker = this.#worker;
    this.#worker = null;
    if (worker !== null) {
      await this.#stopWorker(worker);
    }

    // Retired process ports close their Job Object before returning a bounded
    // termination promise. Waiting here therefore collects errors without ever
    // making Electron shutdown depend on a stuck COM provider.
    while (this.#retiredWorkerTerminations.size > 0) {
      await Promise.all([...this.#retiredWorkerTerminations]);
    }
    if (this.#retiredWorkerErrors.length > 0) {
      const errors = this.#retiredWorkerErrors.splice(0);
      throw new AggregateError(errors, 'Retired selection workers could not be terminated.');
    }

    this.#logger.info('Selection worker stopped');
  }

  async #startWorker(): Promise<void> {
    const worker = this.#workerFactory();
    this.#worker = worker;

    worker.on('message', (message) => {
      this.#handleWorkerMessage(worker, message);
    });
    worker.on('error', (error) => {
      this.#handleWorkerFailure(worker, error);
    });
    worker.on('exit', (exitCode) => {
      this.#handleWorkerExit(worker, exitCode);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#startup?.worker !== worker) {
          return;
        }
        this.#startup = null;
        reject(new Error('Selection worker startup timed out.'));
        this.#retireWorker(worker, false);
      }, this.#startupTimeoutMs);

      this.#startup = {
        worker,
        resolve,
        reject,
        timeout,
      };
    });
  }

  async #stopWorker(worker: SelectionWorkerPort): Promise<void> {
    // Let the child clean up normally first. If it is blocked in UIA/MSAA, its
    // Job Object is then closed and all native threads disappear with the process.
    const exited = new Promise<boolean>((resolve) => {
      worker.once('exit', () => resolve(true));
    });
    try {
      worker.postMessage({ type: 'shutdown' });
    } catch {
      await this.#terminateWorker(worker);
      return;
    }

    let timeout: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
      exited,
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (!graceful) {
      await this.#terminateWorker(worker);
    }
  }

  #handleWorkerMessage(worker: SelectionWorkerPort, message: SelectionWorkerMessage): void {
    if (worker !== this.#worker) {
      return;
    }

    switch (message.type) {
      case 'ready': {
        this.#running = true;
        this.#workerResponsive = true;
        const startup = this.#startup;
        if (startup?.worker === worker) {
          clearTimeout(startup.timeout);
          this.#startup = null;
          startup.resolve();
        }
        this.#logger.info('Selection worker started');
        return;
      }
      case 'startup-error':
        this.#handleWorkerFailure(
          worker,
          new Error('Selection worker startup failed: ' + message.errorName),
        );
        return;
      case 'runtime-error':
        this.#logger.warn('Selection worker reported an error', {
          errorName: message.errorName,
        });
        return;
      case 'mouse-down':
        this.#handleMouseDown(message.data);
        return;
      case 'key-down':
      case 'key-up':
        return;
      case 'selection-result': {
        const retireTimer = this.#timedOutQueryRetireTimers.get(message.requestId);
        if (retireTimer !== undefined) {
          clearTimeout(retireTimer);
          this.#timedOutQueryRetireTimers.delete(message.requestId);
        }

        const pending = this.#pendingQueries.get(message.requestId);
        // Unknown or superseded IDs must not revive a worker. A result is authoritative
        // only while its request is pending or while its own timeout grace is active.
        if (pending === undefined && retireTimer === undefined) {
          return;
        }
        this.#workerResponsive = true;
        if (pending === undefined) {
          return;
        }
        this.#pendingQueries.delete(message.requestId);
        clearTimeout(pending.timeout);
        if (message.errorName !== null) {
          this.#logger.debug('Selection worker returned no result', {
            errorName: message.errorName,
          });
        }
        pending.resolve(message.data);
      }
    }
  }

  #handleWorkerFailure(worker: SelectionWorkerPort, error: Error): void {
    if (worker !== this.#worker) {
      return;
    }

    this.#logger.error('Selection worker failed', {
      name: error.name,
      message: error.message,
    });

    const wasRunning = this.#running;
    const startup = this.#startup;
    if (startup?.worker === worker) {
      clearTimeout(startup.timeout);
      this.#startup = null;
      startup.reject(error);
    }
    this.#retireWorker(worker, wasRunning);
  }

  #handleWorkerExit(worker: SelectionWorkerPort, exitCode: number): void {
    if (worker !== this.#worker) {
      return;
    }

    const wasRunning = this.#running;
    if (this.#shouldRun) {
      this.#logger.warn('Selection worker exited unexpectedly', { exitCode });
    }
    this.#retireWorker(worker, this.#shouldRun && wasRunning);
  }

  #retireWorker(worker: SelectionWorkerPort, restart: boolean): void {
    if (worker !== this.#worker) {
      return;
    }

    this.#worker = null;
    this.#running = false;
    this.#workerResponsive = false;
    this.#selectionQuery = null;
    this.#failPendingQueries();
    this.#clearRetireTimers();
    worker.unref?.();
    this.#trackRetiredWorkerTermination(worker);

    if (restart && this.#shouldRun) {
      setTimeout(() => {
        if (this.#shouldRun && this.#worker === null) {
          void this.start().catch((error: unknown) => {
            this.#logger.error('Selection worker recovery failed', {
              errorName: error instanceof Error ? error.name : 'UnknownError',
            });
          });
        }
      }, 100);
    }
  }

  #trackRetiredWorkerTermination(worker: SelectionWorkerPort): void {
    let termination: Promise<void>;
    termination = this.#terminateWorker(worker)
      .catch((error: unknown) => {
        this.#retiredWorkerErrors.push(error);
      })
      .finally(() => {
        this.#retiredWorkerTerminations.delete(termination);
      });
    this.#retiredWorkerTerminations.add(termination);
  }

  async #terminateWorker(worker: SelectionWorkerPort): Promise<void> {
    worker.unref?.();
    let timeout: NodeJS.Timeout | undefined;
    const rawTermination = Promise.resolve()
      .then(() => worker.terminate())
      .then(() => undefined);
    // Observe late rejection even after the deadline. Real process ports close
    // their Job synchronously; this outer bound also protects test adapters and
    // future implementations from reintroducing an unbounded app shutdown.
    void rawTermination.catch(() => undefined);
    const outcome = await Promise.race([
      rawTermination.then(() => 'terminated' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), this.#workerTerminationTimeoutMs);
      }),
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (outcome === 'timeout') {
      this.#logger.warn('Selection process termination observation timed out');
    }
  }

  #requestSelection(): Promise<TextSelectionData | null> {
    if (this.#selectionQuery !== null) {
      // Native getCurrentSelection() is synchronous inside its worker. Sharing one
      // in-flight query prevents rapid hotkeys from queuing delayed UIA/Ctrl+C work
      // that would execute after the corresponding popup request was cancelled.
      return this.#selectionQuery;
    }

    const query = this.#startSelectionQuery();
    this.#selectionQuery = query;
    void query
      .finally(() => {
        if (this.#selectionQuery === query) {
          this.#selectionQuery = null;
        }
      })
      .catch(() => undefined);
    return query;
  }

  #startSelectionQuery(): Promise<TextSelectionData | null> {
    const worker = this.#worker;
    if (worker === null || !this.#running || !this.#workerResponsive) {
      return Promise.resolve(null);
    }

    const requestId = this.#nextRequestId++;
    return new Promise<TextSelectionData | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pendingQueries.delete(requestId)) {
          return;
        }

        const error = new Error('Selection worker query timed out.');
        error.name = 'SelectionQueryTimeoutError';
        this.#workerResponsive = false;
        reject(error);

        // Clipboard transactionはNative側で必ず復元まで完了させる。
        // UIだけ先にFallbackへ進め、さらに応答が戻らないWorkerだけを猶予後に退役させる。
        const retireTimer = setTimeout(() => {
          this.#timedOutQueryRetireTimers.delete(requestId);
          if (worker === this.#worker && !this.#workerResponsive) {
            this.#retireWorker(worker, true);
          }
        }, this.#hungWorkerRetireMs);
        this.#timedOutQueryRetireTimers.set(requestId, retireTimer);
      }, this.#queryTimeoutMs);

      this.#pendingQueries.set(requestId, { resolve, timeout });
      try {
        worker.postMessage({ type: 'resolve-selection', requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.#pendingQueries.delete(requestId);
        reject(error);
      }
    });
  }

  #failPendingQueries(): void {
    for (const pending of this.#pendingQueries.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.#pendingQueries.clear();
  }

  #clearRetireTimers(): void {
    for (const timeout of this.#timedOutQueryRetireTimers.values()) {
      clearTimeout(timeout);
    }
    this.#timedOutQueryRetireTimers.clear();
  }

  #handleMouseDown(data: MouseEventData): void {
    const point = { x: data.x, y: data.y };
    for (const listener of this.#mouseDownListeners) {
      listener(point);
    }
  }

  #toResolvedSelection(data: TextSelectionData): ResolvedSelection {
    const text = this.#normalizeText(data.text);
    const acquiredAt = this.#now();

    return {
      text,
      programName: data.programName.trim().length === 0 ? null : data.programName,
      method: this.#selectionMethod(data.method),
      anchor: this.#selectionAnchor(data),
      acquiredAt,
    };
  }

  #normalizeText(input: string): string {
    const text = input.replaceAll('\u0000', '').trim();
    if (text.length === 0) {
      throw new Error('Selected text is empty.');
    }

    if (
      text.length > this.#maxCodePoints * 2 ||
      (text.length > this.#maxCodePoints && Array.from(text).length > this.#maxCodePoints)
    ) {
      throw new SelectionTextTooLargeError(this.#maxCodePoints);
    }

    return text;
  }

  #selectionMethod(method: number): SelectionMethod {
    switch (method) {
      case SELECTION_METHOD_UIA:
        return 'uia';
      case SELECTION_METHOD_ACCESSIBLE:
        return 'accessible';
      case SELECTION_METHOD_CLIPBOARD:
        return 'clipboard-copy';
      default:
        return 'unknown';
    }
  }

  #selectionAnchor(data: TextSelectionData): SelectionAnchor | null {
    if (
      data.posLevel >= POSITION_LEVEL_SELECTION_FULL &&
      this.#validPoint(data.endTop) &&
      this.#validPoint(data.endBottom)
    ) {
      return {
        kind: 'selection',
        rect: {
          x: Math.min(data.endTop.x, data.endBottom.x),
          y: Math.min(data.endTop.y, data.endBottom.y),
          width: Math.max(1, Math.abs(data.endBottom.x - data.endTop.x)),
          height: Math.max(1, Math.abs(data.endBottom.y - data.endTop.y)),
        },
      };
    }

    if (this.#validPoint(data.mousePosEnd)) {
      return {
        kind: 'mouse',
        point: data.mousePosEnd,
      };
    }

    return null;
  }

  #validPoint(point: Point): boolean {
    return (
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x !== INVALID_COORDINATE &&
      point.y !== INVALID_COORDINATE
    );
  }
}
