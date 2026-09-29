import {
  type LlmClient,
  type LlmImageInput,
  type LlmRequest,
  type LlmSession,
  type LlmStreamEvent,
} from '@fumu/llm-core';
import { describe, expect, it } from 'vitest';
import {
  LlmImageTextExtractionService,
  MAX_IMAGE_TEXT_EXTRACTION_IMAGES,
} from './image-text-extraction';

const image: LlmImageInput = {
  mediaType: 'image/png',
  base64Data: 'aW1hZ2U=',
};

class FakeSession implements LlmSession {
  closed = false;

  constructor(
    private readonly events: readonly LlmStreamEvent[],
    private readonly closeError?: Error,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<LlmStreamEvent> {
    yield* this.events;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

class FakeClient implements LlmClient {
  readonly session: FakeSession;
  request: LlmRequest | null = null;

  constructor(events: readonly LlmStreamEvent[], closeError?: Error) {
    this.session = new FakeSession(events, closeError);
  }

  async createSession(request: LlmRequest): Promise<LlmSession> {
    this.request = request;
    return this.session;
  }
}

describe('LlmImageTextExtractionService', () => {
  it('attaches the image and returns a completed transcription', async () => {
    const client = new FakeClient(
      [
        { type: 'text-delta', text: 'OCR result:\n```json\n{"text":"  Hello\\n' },
        { type: 'text-delta', text: 'world.  ","hasText":true}\n```\nDone.' },
      ],
      new Error('close failed'),
    );

    const result = await new LlmImageTextExtractionService(client).extract({
      requestId: 'request-1',
      images: [image],
    });

    expect(result).toEqual({ status: 'completed', text: 'Hello\nworld.' });
    expect(client.request?.messages[1]).toMatchObject({ role: 'user', images: [image] });
    expect(client.request).toMatchObject({
      responseFormat: 'json-object',
      temperature: 0,
      maxOutputTokens: expect.any(Number),
    });
    expect(client.session.closed).toBe(true);
  });

  it('classifies an empty or unreadable transcription as no-text', async () => {
    const client = new FakeClient([{ type: 'text-delta', text: '{"text":"","hasText":false}' }]);

    await expect(
      new LlmImageTextExtractionService(client).extract({
        requestId: 'request-1',
        images: [image],
      }),
    ).resolves.toEqual({ status: 'no-text' });
    expect(client.session.closed).toBe(true);
  });

  it('rejects malformed JSON as an invalid response', async () => {
    const client = new FakeClient([{ type: 'text-delta', text: '{"text":"unfinished"' }]);

    await expect(
      new LlmImageTextExtractionService(client).extract({
        requestId: 'request-1',
        images: [image],
      }),
    ).rejects.toMatchObject({ code: 'invalid-response', retryable: false });
    expect(client.session.closed).toBe(true);
  });

  it('rejects missing images and too many images before contacting the provider', async () => {
    const client = new FakeClient([]);
    const service = new LlmImageTextExtractionService(client);

    await expect(service.extract({ requestId: 'empty', images: [] })).rejects.toMatchObject({
      code: 'invalid-configuration',
      retryable: false,
    });
    await expect(
      service.extract({
        requestId: 'too-many',
        images: Array.from({ length: MAX_IMAGE_TEXT_EXTRACTION_IMAGES + 1 }, () => image),
      }),
    ).rejects.toMatchObject({ code: 'request-too-large', retryable: false });

    expect(client.request).toBeNull();
  });
});
