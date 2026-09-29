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
    expect(JSON.parse(String(init?.body))).toMatchObject({
      messages: request.messages,
    });
    expect(events).toContainEqual({ type: 'text-delta', text: 'translated' });
  });

  it('sends user images as ordered Chat Completions content parts', async () => {
    const fetcher = vi.fn<FetchLike>(async () => eventStream(['data: [DONE]\n\n']));
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      fetch: fetcher,
    });
    const session = await client.createSession({
      messages: [
        {
          role: 'user',
          content: 'Read this',
          images: [
            { mediaType: 'image/png', base64Data: 'cG5n' },
            { mediaType: 'image/jpeg', base64Data: 'anBn' },
          ],
        },
        {
          role: 'user',
          content: '',
          images: [{ mediaType: 'image/png', base64Data: 'cG5n' }],
        },
        { role: 'user', content: '', images: [] },
      ],
    });
    await session.close();

    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,anBn' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } }],
        },
        { role: 'user', content: '' },
      ],
    });
  });

  it('classifies unsupported image models without changing text error classification', async () => {
    const fetcher = vi.fn<FetchLike>(
      async () =>
        new Response('{"error":{"message":"This model does not support image inputs."}}', {
          status: 400,
        }),
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      fetch: fetcher,
    });

    await expect(
      client.createSession({
        messages: [
          {
            role: 'user',
            content: 'Read this',
            images: [{ mediaType: 'image/png', base64Data: 'cG5n' }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input', retryable: false, status: 400 });
    await expect(client.createSession(request)).rejects.toMatchObject({
      code: 'unknown',
      retryable: false,
      status: 400,
    });
  });
});
