import type { LlmRequest, LlmStreamEvent } from '@fumu/llm-core';
import { describe, expect, it, vi } from 'vitest';
import { GoogleGeminiClient, type FetchLike } from './index';

const request: LlmRequest = {
  messages: [
    { role: 'system', content: 'You are a translator.' },
    { role: 'user', content: 'hello' },
  ],
  maxOutputTokens: 512,
};

function eventStream(payloads: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const payload of payloads) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('GoogleGeminiClient', () => {
  it('uses the official endpoint and credential header for a successful stream', async () => {
    const fetcher = vi.fn<FetchLike>(async () =>
      eventStream([
        { candidates: [{ content: { parts: [{ text: 'translated' }], role: 'model' } }] },
        { candidates: [{ finishReason: 'STOP' }] },
      ]),
    );
    const client = new GoogleGeminiClient({
      model: 'gemini-2.5-flash',
      apiKey: 'secret',
      fetch: fetcher,
    });
    const session = await client.createSession(request);
    const events: LlmStreamEvent[] = [];
    for await (const event of session) events.push(event);
    await session.close();

    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'secret' });
    expect(events).toContainEqual({ type: 'text-delta', text: 'translated' });
  });
});
