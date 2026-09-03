import { describe, expect, it } from 'vitest';
import { HttpResponseLimitError, streamSseData } from './index';

function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('bounded HTTP SSE transport', () => {
  it('rejects an unbounded event before it can grow indefinitely', async () => {
    const read = async (): Promise<void> => {
      for await (const _value of streamSseData(
        byteStream(['data: ', 'x'.repeat(65)]),
        new AbortController().signal,
        { maxEventBytes: 64, maxResponseBytes: 1_024 },
      )) {
        // The missing event separator must not allow the buffer to grow without a bound.
      }
    };

    await expect(read()).rejects.toBeInstanceOf(HttpResponseLimitError);
  });
});
