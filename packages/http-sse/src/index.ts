const DEFAULT_MAX_EVENT_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 8_388_608;
const DEFAULT_MAX_ERROR_BODY_BYTES = 2_048;

export class HttpResponseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpResponseLimitError';
  }
}

export interface SseReadLimits {
  readonly maxEventBytes?: number;
  readonly maxResponseBytes?: number;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('HTTP stream limits must be positive safe integers.');
  }
  return value;
}

function dataFromEventBlock(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/gu)) {
    if (line.startsWith(':')) {
      continue;
    }
    if (line === 'data') {
      dataLines.push('');
    } else if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  return dataLines.length === 0 ? null : dataLines.join('\n');
}

function assertEventByteLimit(byteLength: number, maxEventBytes: number): void {
  if (byteLength > maxEventBytes) {
    throw new HttpResponseLimitError('The provider SSE event exceeded the safety limit.');
  }
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

interface EventBoundary {
  readonly blockEnd: number;
  readonly nextEventStart: number;
}

/** Finds an empty SSE line while treating CRLF as one line ending. */
function findEventBoundary(bytes: Uint8Array): EventBoundary | null {
  let lineStart = 0;
  let previousLineEndingStart: number | null = null;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];
    let lineEndingLength = 0;
    if (byte === 0x0a) {
      lineEndingLength = 1;
    } else if (byte === 0x0d) {
      lineEndingLength = bytes[index + 1] === 0x0a ? 2 : 1;
    } else {
      continue;
    }

    if (index === lineStart) {
      return {
        blockEnd: previousLineEndingStart ?? 0,
        nextEventStart: index + lineEndingLength,
      };
    }
    previousLineEndingStart = index;
    lineStart = index + lineEndingLength;
    index += lineEndingLength - 1;
  }
  return null;
}

function unfinishedEventBytes(bytes: Uint8Array): number {
  if (bytes.byteLength >= 2 && bytes.at(-2) === 0x0d && bytes.at(-1) === 0x0a) {
    return bytes.byteLength - 2;
  }
  if (bytes.at(-1) === 0x0d || bytes.at(-1) === 0x0a) {
    return bytes.byteLength - 1;
  }
  return bytes.byteLength;
}

export async function* streamSseData(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limits: SseReadLimits = {},
): AsyncIterable<string> {
  const maxEventBytes = positiveLimit(limits.maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
  const maxResponseBytes = positiveLimit(limits.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer: Uint8Array = new Uint8Array();
  let responseBytes = 0;

  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException('The provider request was cancelled.', 'AbortError');
      }
      const result = await reader.read();
      if (result.value !== undefined) {
        responseBytes += result.value.byteLength;
        if (responseBytes > maxResponseBytes) {
          throw new HttpResponseLimitError('The provider response exceeded the safety limit.');
        }
      }
      if (result.value !== undefined) {
        buffer = concatenateBytes(buffer, result.value);
      }

      let boundary = findEventBoundary(buffer);
      while (boundary !== null) {
        assertEventByteLimit(boundary.blockEnd, maxEventBytes);
        const eventBlock = decoder.decode(buffer.subarray(0, boundary.blockEnd));
        buffer = buffer.slice(boundary.nextEventStart);
        const data = dataFromEventBlock(eventBlock);
        if (data !== null) {
          yield data;
        }
        boundary = findEventBoundary(buffer);
      }

      // A final line ending is not event content and may be the first half of the
      // blank-line delimiter. Everything else is bounded as received bytes.
      assertEventByteLimit(unfinishedEventBytes(buffer), maxEventBytes);

      if (result.done) {
        assertEventByteLimit(unfinishedEventBytes(buffer), maxEventBytes);
        const data = dataFromEventBlock(decoder.decode(buffer));
        if (data !== null) {
          yield data;
        }
        return;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = DEFAULT_MAX_ERROR_BODY_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const limit = positiveLimit(maxBytes, DEFAULT_MAX_ERROR_BODY_BYTES);
  if (signal?.aborted === true) {
    throw new DOMException('The provider request was cancelled.', 'AbortError');
  }
  const body = response.body;
  if (body === null) {
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rejectOnAbort: ((error: DOMException) => void) | undefined;
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          rejectOnAbort = reject;
        });
  const abort = (): void => {
    const error = new DOMException('The provider request was cancelled.', 'AbortError');
    // cancel()だけでは基盤のストリーム実装次第で完了を待つ可能性があるため、
    // read()の待機自体も拒否して呼び出し元へ中断を即座に返す。
    rejectOnAbort?.(error);
    void reader.cancel(error).catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  let remaining = limit;
  let text = '';
  try {
    while (remaining > 0) {
      const read = reader.read();
      const result =
        abortPromise === undefined ? await read : await Promise.race([read, abortPromise]);
      if (result.done) {
        text += decoder.decode();
        return text;
      }
      const value = result.value;
      const accepted = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      const reachedLimit =
        accepted.byteLength < value.byteLength || accepted.byteLength === remaining;
      // A bounded diagnostic prefix is intentionally finalised at the byte limit.
      // This prevents an incomplete trailing UTF-8 sequence from remaining buffered
      // after the response body has been cancelled.
      text += decoder.decode(accepted, { stream: !reachedLimit });
      remaining -= accepted.byteLength;
      if (reachedLimit) {
        await reader.cancel().catch(() => undefined);
        return text;
      }
    }
    return text;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
