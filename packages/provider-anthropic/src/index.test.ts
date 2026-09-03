import type { LlmRequest, LlmStreamEvent } from '@fumu/llm-core';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicClient, type FetchLike } from './index';

const request: LlmRequest = {
  messages: [
    { role: 'system', content: 'You are a translator.' },
    { role: 'user', content: 'hello' },
  ],
  temperature: 0.2,
  maxOutputTokens: 256,
  responseFormat: 'json-object',
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

describe('AnthropicClient', () => {
  it('uses the official endpoint and credential header for a successful stream', async () => {
    const fetcher = vi.fn<FetchLike>(async () =>
      eventStream([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'translated' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]),
    );
    const client = new AnthropicClient({
      model: 'claude-sonnet-4-5',
      apiKey: 'secret',
      fetch: fetcher,
    });
    const session = await client.createSession(request);
    const events: LlmStreamEvent[] = [];
    for await (const event of session) events.push(event);
    await session.close();

    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.headers).toMatchObject({
      'x-api-key': 'secret',
      'anthropic-version': '2023-06-01',
    });
    expect(events).toContainEqual({ type: 'text-delta', text: 'translated' });
  });
});
