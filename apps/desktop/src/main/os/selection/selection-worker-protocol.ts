import type { KeyboardEventData, MouseEventData, TextSelectionData } from 'selection-hook';

export type SelectionWorkerRequest =
  | {
      readonly type: 'resolve-selection';
      readonly requestId: number;
    }
  | {
      readonly type: 'shutdown';
    };

export type SelectionWorkerMessage =
  | {
      readonly type: 'ready';
    }
  | {
      readonly type: 'startup-error';
      readonly errorName: string;
    }
  | {
      readonly type: 'runtime-error';
      readonly errorName: string;
    }
  | {
      readonly type: 'mouse-down';
      readonly data: MouseEventData;
    }
  | {
      readonly type: 'key-down';
      readonly data: KeyboardEventData;
    }
  | {
      readonly type: 'key-up';
      readonly data: KeyboardEventData;
    }
  | {
      readonly type: 'selection-result';
      readonly requestId: number;
      readonly data: TextSelectionData | null;
      readonly errorName: string | null;
    };

// ServiceとProcess adapterの双方が依存する境界をwire messageと同じ中立な場所に置く。
// 片方からもう片方の実装型をimportすると、型だけでも依存グラフが循環してしまう。
export interface SelectionWorkerPort {
  on(event: 'message', listener: (message: SelectionWorkerMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (exitCode: number) => void): this;
  once(event: 'exit', listener: (exitCode: number) => void): this;
  postMessage(message: SelectionWorkerRequest): void;
  unref?(): void;
  terminate(): Promise<number>;
}
