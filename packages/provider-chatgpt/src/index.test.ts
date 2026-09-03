import { describe, expect, it, vi } from 'vitest';
import {
  ChatGptClient,
  parseChatGptCredential,
  serializeChatGptCredential,
  type FetchLike,
} from './index';

function streamResponse(events: readonly unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('ChatGPT provider credential boundary', () => {
  it('rejects malformed or oversized credentials before a provider request', () => {
    expect(() => parseChatGptCredential('{"type":"oauth"}')).toThrow(/壊れています/u);
    expect(() => parseChatGptCredential('x'.repeat(1024 * 1024 + 1))).toThrow(/大きすぎ/u);
  });

  it('sends account-scoped requests and normalizes the response stream', async () => {
    const fetchRequest = vi.fn<FetchLike>(async () =>
      streamResponse([
        { type: 'response.output_text.delta', delta: '訳文' },
        { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 4 } } },
      ]),
    );
    const client = new ChatGptClient({
      model: 'gpt-5.6-sol',
      credential: serializeChatGptCredential({
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 3_600_000,
        accountId: 'account-id',
      }),
      onCredentialChanged: vi.fn(),
      fetch: fetchRequest,
    });

    const session = await client.createSession({
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.2,
      maxOutputTokens: 2_048,
      responseFormat: 'json-object',
    });
    const events = [];
    for await (const event of session) events.push(event);

    const [endpoint, init] = fetchRequest.mock.calls[0] ?? [];
    expect(endpoint).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect((init?.headers as Record<string, string>)['ChatGPT-Account-Id']).toBe('account-id');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('text');
    expect(events).toContainEqual({ type: 'text-delta', text: '訳文' });
  });

  it('refreshes expired credentials and persists rotated tokens', async () => {
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'account-next' })).toString(
      'base64url',
    );
    const changed = vi.fn();
    const fetchRequest = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith('/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: `header.${payload}.signature`,
            refresh_token: 'refresh-next',
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      return streamResponse([
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    });
    const client = new ChatGptClient({
      model: 'gpt-5.4',
      credential: serializeChatGptCredential({
        type: 'oauth',
        access: 'expired',
        refresh: 'refresh-old',
        expires: 0,
        accountId: 'account-old',
      }),
      onCredentialChanged: changed,
      fetch: fetchRequest,
    });

    const session = await client.createSession({ messages: [{ role: 'user', content: 'Hello' }] });
    for await (const _event of session) {
      // Consume the stream so credential persistence completes.
    }

    expect(parseChatGptCredential(changed.mock.calls[0]?.[0] as string)).toMatchObject({
      refresh: 'refresh-next',
      accountId: 'account-next',
    });
  });
});
