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

  it('sends image parts before nonempty text and omits empty text parts', async () => {
    const fetcher = vi.fn<FetchLike>(async () => eventStream([]));
    const client = new GoogleGeminiClient({ model: 'gemini-2.5-flash', fetch: fetcher });
    const session = await client.createSession({
      messages: [
        {
          role: 'user',
          content: 'Read this image',
          images: [
            { mediaType: 'image/png', base64Data: 'cG5n' },
            { mediaType: 'image/jpeg', base64Data: 'anBlZw==' },
          ],
        },
        {
          role: 'user',
          content: '',
          images: [{ mediaType: 'image/jpeg', base64Data: 'ZW1wdHk=' }],
        },
      ],
    });
    await session.close();

    const init = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as { contents: unknown[] };
    expect(body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'cG5n' } },
          { inlineData: { mimeType: 'image/jpeg', data: 'anBlZw==' } },
          { text: 'Read this image' },
        ],
      },
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'ZW1wdHk=' } }],
      },
    ]);
  });

  it('classifies image capability rejections only for image requests', async () => {
    const fetcher = vi.fn<FetchLike>(
      async () =>
        new Response(
          JSON.stringify({ error: { message: 'This model does not support image input' } }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const client = new GoogleGeminiClient({ model: 'gemini-2.5-flash', fetch: fetcher });
    const imageRequest: LlmRequest = {
      messages: [
        { role: 'user', content: '', images: [{ mediaType: 'image/png', base64Data: 'cG5n' }] },
      ],
    };

    await expect(client.createSession(imageRequest)).rejects.toMatchObject({
      code: 'unsupported-input',
      retryable: false,
      status: 400,
    });
    await expect(client.createSession(request)).rejects.toMatchObject({
      code: 'unknown',
      retryable: false,
      status: 400,
    });
  });
});
