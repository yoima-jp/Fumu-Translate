import type { LlmRequest, LlmStreamEvent } from '@fumu/llm-core';
import { describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleClient, type FetchLike } from './index';

const request: LlmRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  responseFormat: 'json-object',
};

function eventStream(payloads: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const payload of payloads) controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('OpenAiCompatibleClient', () => {
  it('uses the configured endpoint and bearer credential for a successful stream', async () => {
    const fetcher = vi.fn<FetchLike>(async () =>
      eventStream([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'translated' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      apiKey: 'secret',
      fetch: fetcher,
    });
    const session = await client.createSession(request);
    const events: LlmStreamEvent[] = [];
    for await (const event of session) events.push(event);
    await session.close();

    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe('https://api.example.com/v1/chat/completions');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
    expect(events).toContainEqual({ type: 'text-delta', text: 'translated' });
  });
});
