import type { LlmClient, LlmRequest, LlmSession, LlmStreamEvent } from '@fumu/llm-core';
import { describe, expect, it } from 'vitest';
import { MAX_TRANSLATION_SOURCE_CODE_POINTS, type TranslationEvent } from './contracts';
import { StreamingTranslationService } from './translation-service';

class FakeSession implements LlmSession {
  closed = false;

  constructor(private readonly events: readonly LlmStreamEvent[]) {}

  async *[Symbol.asyncIterator](): AsyncIterator<LlmStreamEvent> {
    yield* this.events;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeClient implements LlmClient {
  readonly session: FakeSession;
  request: LlmRequest | null = null;

  constructor(events: readonly LlmStreamEvent[]) {
    this.session = new FakeSession(events);
  }

  async createSession(request: LlmRequest): Promise<LlmSession> {
    this.request = request;
    return this.session;
  }
}

async function collect(client: FakeClient, sourceText = 'That works for me.') {
  const events: TranslationEvent[] = [];
  for await (const event of new StreamingTranslationService(client).translate({
    requestId: 'request-1',
    sourceText,
  })) {
    events.push(event);
  }
  return events;
}

describe('StreamingTranslationService', () => {
  it('streams and validates a provider result', async () => {
    const client = new FakeClient([
      { type: 'text-delta', text: '{"translation":"それで' },
      { type: 'text-delta', text: '大丈夫です。","explanation":"自然な同意"}' },
      { type: 'usage', inputTokens: 12, outputTokens: 24 },
    ]);

    const events = await collect(client);

    expect(events.some((event) => event.type === 'snapshot')).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      value: { translation: 'それで大丈夫です。', explanation: '自然な同意' },
      inputTokens: 12,
      outputTokens: 24,
    });
    expect(client.request?.responseFormat).toBe('json-object');
    expect(client.session.closed).toBe(true);
  });

  it('rejects oversized source text before contacting a provider', async () => {
    const client = new FakeClient([]);
    const events = await collect(client, 'a'.repeat(MAX_TRANSLATION_SOURCE_CODE_POINTS + 1));

    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'request-too-large' });
    expect(client.request).toBeNull();
  });

  it('rejects an incomplete provider result', async () => {
    const events = await collect(
      new FakeClient([{ type: 'text-delta', text: '{"translation":"途中' }]),
    );

    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'invalid-response' });
  });
});
