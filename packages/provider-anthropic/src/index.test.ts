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
    expect(JSON.parse(String(init?.body))).toMatchObject({
      system: 'You are a translator.',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(events).toContainEqual({ type: 'text-delta', text: 'translated' });
  });

  it('sends user images before text and omits an empty text block', async () => {
    const fetcher = vi.fn<FetchLike>(async () => eventStream([]));
    const client = new AnthropicClient({ model: 'claude-sonnet-4-5', fetch: fetcher });
    const imageRequest: LlmRequest = {
      messages: [
        { role: 'system', content: 'You are a translator.' },
        {
          role: 'user',
          content: '',
          images: [{ mediaType: 'image/png', base64Data: 'png-data' }],
        },
        {
          role: 'user',
          content: 'Read the text.',
          images: [
            { mediaType: 'image/jpeg', base64Data: 'jpeg-data' },
            { mediaType: 'image/png', base64Data: 'second-png-data' },
          ],
        },
      ],
    };

    const session = await client.createSession(imageRequest);
    await session.close();

    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'png-data' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'jpeg-data' },
            },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'second-png-data' },
            },
            { type: 'text', text: 'Read the text.' },
          ],
        },
      ],
    });
  });

  it('classifies an image capability rejection as unsupported input', async () => {
    const fetcher = vi.fn<FetchLike>(
      async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'This model does not support vision.',
            },
          }),
          { status: 400 },
        ),
    );
    const client = new AnthropicClient({ model: 'claude-sonnet-4-5', fetch: fetcher });

    await expect(
      client.createSession({
        messages: [
          {
            role: 'user',
            content: 'Read this.',
            images: [{ mediaType: 'image/png', base64Data: 'data' }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input', retryable: false, status: 400 });
  });

  it('keeps text-only HTTP 400 errors in the existing classification', async () => {
    const fetcher = vi.fn<FetchLike>(
      async () => new Response('Vision is unavailable for this request.', { status: 400 }),
    );
    const client = new AnthropicClient({ model: 'claude-sonnet-4-5', fetch: fetcher });

    await expect(client.createSession(request)).rejects.toMatchObject({
      code: 'unknown',
      retryable: false,
      status: 400,
    });
  });
});
