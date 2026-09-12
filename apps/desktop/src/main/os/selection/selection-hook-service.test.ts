import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextSelectionData } from 'selection-hook';
import { SelectionHookService } from './selection-hook-service';
import type { SelectionWorkerRequest } from './selection-worker-protocol';

vi.mock('electron-log/main', () => ({
  default: { scope: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('./selection-process-port', () => ({ createSelectionProcessFactory: vi.fn() }));

const data = {
  text: 'selected text',
  programName: 'fixture.exe',
  method: 1,
  posLevel: 0,
  startTop: { x: -99999, y: -99999 },
  startBottom: { x: -99999, y: -99999 },
  endTop: { x: -99999, y: -99999 },
  endBottom: { x: -99999, y: -99999 },
  mousePosStart: { x: -99999, y: -99999 },
  mousePosEnd: { x: -99999, y: -99999 },
} as TextSelectionData;

class Worker extends EventEmitter {
  requests: SelectionWorkerRequest[] = [];
  terminate = vi.fn(async () => 0);
  postMessage(message: SelectionWorkerRequest): void {
    this.requests.push(message);
    if (message.type === 'shutdown') this.emit('exit', 0);
  }
  result(): void {
    const request = this.requests.find((message) => message.type === 'resolve-selection');
    if (request?.type !== 'resolve-selection') throw new Error('No selection request');
    this.emit('message', {
      type: 'selection-result',
      requestId: request.requestId,
      data,
      errorName: null,
    });
  }
}

async function fixture() {
  const workers: Worker[] = [];
  const service = new SelectionHookService({
    workerFactory: () => {
      const worker = new Worker();
      workers.push(worker);
      queueMicrotask(() => worker.emit('message', { type: 'ready' }));
      return worker;
    },
  });
  await service.start();
  return { service, worker: workers[0]!, workers };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('selection retrieval deadlines and modifiers', () => {
  it('queries with held modifiers and accepts text without coordinates', async () => {
    const { service, worker } = await fixture();
    worker.emit('message', { type: 'key-down', data: { uniKey: 'Alt' } });
    const result = service.resolveSelection();
    expect(worker.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(350);
    worker.result();
    await expect(result).resolves.toMatchObject({ text: 'selected text', anchor: null });
    await service.stop();
  });

  it('accepts slow provider results beyond the old one-second cutoff', async () => {
    const { service, worker } = await fixture();
    const result = service.resolveSelection();
    await vi.advanceTimersByTimeAsync(1500);
    worker.result();
    await expect(result).resolves.toMatchObject({ text: 'selected text' });
    await service.stop();
  });

  it('bounds a hung query, ignores its late text and permits the next query', async () => {
    const { service, worker } = await fixture();
    const result = service.resolveSelection();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBeNull();
    worker.result();
    worker.requests.length = 0;
    const retry = service.resolveSelection();
    worker.result();
    await expect(retry).resolves.toMatchObject({ text: 'selected text' });
    await service.stop();
  });

  it('replaces a permanently hung worker after its cleanup grace', async () => {
    const { service, worker, workers } = await fixture();
    const result = service.resolveSelection();
    await vi.advanceTimersByTimeAsync(10100);
    await expect(result).resolves.toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(2);
    expect(service.isRunning).toBe(true);
    await service.stop();
  });
});
