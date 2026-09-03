import { createHash, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { readBoundedResponseText, streamSseData } from '@fumu/http-sse';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@fumu/i18n';
import {
  isAbortError,
  LlmProviderError,
  type FetchLike,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmSession,
  type LlmStreamEvent,
} from '@fumu/llm-core';
import { oauthPageNotFoundText, renderOAuthPage } from './oauth-page';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_ORIGIN = 'https://auth.openai.com';
const RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const CALLBACK_PORT = 1455;
const CALLBACK_URL = `http://localhost:${String(CALLBACK_PORT)}/auth/callback`;
const MAX_CREDENTIAL_BYTES = 1_048_576;
const MAX_TOKEN_RESPONSE_BYTES = 1_048_576;
const REFRESH_SKEW_MS = 60_000;

export type { FetchLike } from '@fumu/llm-core';

export interface ChatGptCredential {
  readonly type: 'oauth';
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId: string;
}

export interface ChatGptModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
}

const CHATGPT_MODELS: readonly ChatGptModel[] = Object.freeze([
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
  },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272_000, maxTokens: 128_000, reasoning: true },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxTokens: 128_000, reasoning: true },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    contextWindow: 128_000,
    maxTokens: 128_000,
    reasoning: true,
  },
]);

export interface ChatGptLoginOptions {
  readonly openUrl: (url: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly fetch?: FetchLike;
  /** callback pageと404応答の表示言語。未指定は英語。 */
  readonly locale?: UiLocale;
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isChatGptCredential(value: unknown): value is ChatGptCredential {
  const record = unknownRecord(value);
  return (
    record !== null &&
    record.type === 'oauth' &&
    typeof record.access === 'string' &&
    record.access.length > 0 &&
    typeof record.refresh === 'string' &&
    record.refresh.length > 0 &&
    typeof record.expires === 'number' &&
    Number.isFinite(record.expires) &&
    typeof record.accountId === 'string' &&
    record.accountId.length > 0
  );
}

function credentialRecord(value: unknown): ChatGptCredential {
  if (!isChatGptCredential(value)) {
    throw new Error('ChatGPTの認証情報が壊れています。再ログインしてください。');
  }
  return value;
}

export function parseChatGptCredential(serialized: string): ChatGptCredential {
  if (new TextEncoder().encode(serialized).byteLength > MAX_CREDENTIAL_BYTES)
    throw new Error('ChatGPTの認証情報が大きすぎます。');
  try {
    return credentialRecord(JSON.parse(serialized) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ChatGPT')) throw error;
    throw new Error('ChatGPTの認証情報が壊れています。再ログインしてください。', { cause: error });
  }
}

export function serializeChatGptCredential(credential: ChatGptCredential): string {
  return JSON.stringify(credentialRecord(credential));
}

export function listChatGptModels(): readonly ChatGptModel[] {
  return CHATGPT_MODELS;
}

function authorizationUrl(state: string, challenge: string): string {
  const url = new URL('/oauth/authorize', AUTH_ORIGIN);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'fumu',
  }).toString();
  return url.toString();
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (payload === undefined || payload.length === 0 || payload.length > 87_384) return null;
  try {
    return unknownRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
  } catch {
    return null;
  }
}

function accountIdFromToken(token: string): string | null {
  const claims = jwtClaims(token);
  if (claims === null) return null;
  if (typeof claims.chatgpt_account_id === 'string' && claims.chatgpt_account_id.length > 0)
    return claims.chatgpt_account_id;
  const auth = unknownRecord(claims['https://api.openai.com/auth']);
  return typeof auth?.chatgpt_account_id === 'string' && auth.chatgpt_account_id.length > 0
    ? auth.chatgpt_account_id
    : null;
}

interface TokenResult {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly id_token?: string;
}

function isTokenResult(value: unknown): value is TokenResult {
  const record = unknownRecord(value);
  return (
    typeof record?.access_token === 'string' &&
    record.access_token.length > 0 &&
    typeof record.expires_in === 'number' &&
    Number.isFinite(record.expires_in) &&
    record.expires_in > 0 &&
    (record.refresh_token === undefined || typeof record.refresh_token === 'string') &&
    (record.id_token === undefined || typeof record.id_token === 'string')
  );
}

async function tokenRequest(
  parameters: URLSearchParams,
  fetchRequest: FetchLike,
  signal: AbortSignal,
): Promise<TokenResult> {
  let response: Response;
  try {
    response = await fetchRequest(new URL('/oauth/token', AUTH_ORIGIN), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: parameters.toString(),
      signal,
      redirect: 'error',
    });
  } catch (error) {
    if (signal.aborted || isAbortError(error))
      throw new DOMException('Login cancelled.', 'AbortError');
    throw new Error('Token endpoint could not be reached.', { cause: error });
  }
  const text = await readBoundedResponseText(response, MAX_TOKEN_RESPONSE_BYTES, signal);
  if (!response.ok) throw new Error(`Token endpoint returned ${String(response.status)}.`);
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error('Token endpoint returned invalid JSON.', { cause: error });
  }
  if (!isTokenResult(payload)) {
    throw new Error('Token endpoint returned an invalid credential.');
  }
  return payload;
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  fetchRequest: FetchLike,
  signal: AbortSignal,
): Promise<ChatGptCredential> {
  const token = await tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK_URL,
    }),
    fetchRequest,
    signal,
  );
  if (token.refresh_token === undefined || token.refresh_token.length === 0)
    throw new Error('Token endpoint did not return a refresh token.');
  const accountId =
    (token.id_token === undefined ? null : accountIdFromToken(token.id_token)) ??
    accountIdFromToken(token.access_token);
  if (accountId === null) throw new Error('ChatGPT account was not present in the token.');
  return {
    type: 'oauth',
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
    accountId,
  };
}

function writeOAuthPage(
  response: ServerResponse,
  status: number,
  kind: 'success' | 'error',
  locale: UiLocale,
): void {
  const body = renderOAuthPage(kind, locale);
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function performLogin(
  options: ChatGptLoginOptions,
  signal: AbortSignal,
): Promise<ChatGptCredential> {
  // 不正値はDEFAULT_UI_LOCALEへ潰す。UiLocale型でもあるが実行時guardで二重化する。
  const locale: UiLocale = options.locale === 'ja' ? 'ja' : DEFAULT_UI_LOCALE;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const fetchRequest = options.fetch ?? globalThis.fetch;
  let settle!: (credential: ChatGptCredential) => void;
  let fail!: (error: unknown) => void;
  const callback = new Promise<ChatGptCredential>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let callbackHandled = false;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', CALLBACK_URL);
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(oauthPageNotFoundText(locale));
        return;
      }
      if (url.searchParams.get('state') !== state) {
        writeOAuthPage(response, 400, 'error', locale);
        return;
      }
      if (callbackHandled) {
        writeOAuthPage(response, 409, 'error', locale);
        return;
      }
      callbackHandled = true;
      const code = url.searchParams.get('code');
      if (code === null || code.length === 0 || url.searchParams.has('error')) {
        writeOAuthPage(response, 400, 'error', locale);
        fail(new Error('Authorization was declined.'));
        return;
      }
      try {
        const credential = await exchangeAuthorizationCode(code, verifier, fetchRequest, signal);
        writeOAuthPage(response, 200, 'success', locale);
        settle(credential);
      } catch (error) {
        writeOAuthPage(response, 502, 'error', locale);
        fail(error);
      }
    })().catch((error: unknown) => {
      if (!response.headersSent) writeOAuthPage(response, 500, 'error', locale);
      fail(error);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(CALLBACK_PORT, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  } catch (error) {
    throw new Error(
      'ChatGPTログインに使うポート1455が使用中です。使用中のアプリを閉じてください。',
      { cause: error },
    );
  }

  const cancelled = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Login cancelled.', 'AbortError'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('Login cancelled.', 'AbortError')),
      { once: true },
    );
  });
  try {
    await options.openUrl(authorizationUrl(state, challenge));
    return await Promise.race([callback, cancelled]);
  } finally {
    await closeServer(server);
  }
}

export async function loginChatGpt(options: ChatGptLoginOptions): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  timeout.unref();
  const abort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    return serializeChatGptCredential(await performLogin(options, controller.signal));
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error))
      throw new Error('ChatGPTログインをキャンセルしました。', { cause: error });
    if (error instanceof Error && error.message.includes('ポート1455')) throw error;
    throw new Error('ChatGPTにログインできませんでした。もう一度お試しください。', {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function refreshCredential(
  credential: ChatGptCredential,
  fetchRequest: FetchLike,
  signal: AbortSignal,
): Promise<ChatGptCredential> {
  const token = await tokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: credential.refresh,
    }),
    fetchRequest,
    signal,
  );
  return {
    type: 'oauth',
    access: token.access_token,
    refresh: token.refresh_token?.length ? token.refresh_token : credential.refresh,
    expires: Date.now() + token.expires_in * 1000,
    accountId:
      (token.id_token === undefined ? null : accountIdFromToken(token.id_token)) ??
      accountIdFromToken(token.access_token) ??
      credential.accountId,
  };
}

function statusError(status: number): LlmProviderError {
  if (status === 401)
    return new LlmProviderError('ChatGPTの認証期限が切れました。再ログインしてください。', {
      code: 'authentication',
      retryable: false,
      status,
    });
  if (status === 403)
    return new LlmProviderError('ChatGPTでこの操作を実行できません。', {
      code: 'permission',
      retryable: false,
      status,
    });
  if (status === 413)
    return new LlmProviderError('ChatGPTへ送る内容が大きすぎます。', {
      code: 'request-too-large',
      retryable: false,
      status,
    });
  if (status === 429)
    return new LlmProviderError('ChatGPTの利用上限に達しました。時間をおいてお試しください。', {
      code: 'rate-limit',
      retryable: true,
      status,
    });
  if (status >= 500)
    return new LlmProviderError('ChatGPTが一時的に利用できません。', {
      code: 'provider-unavailable',
      retryable: true,
      status,
    });
  return new LlmProviderError(`ChatGPTへのリクエストに失敗しました（${String(status)}）。`, {
    code: 'unknown',
    retryable: false,
    status,
  });
}

function invalidResponse(message: string, cause?: unknown): LlmProviderError {
  return new LlmProviderError(message, {
    code: 'invalid-response',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function recordNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseStreamEvent(data: string): readonly LlmStreamEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch (error) {
    throw invalidResponse('ChatGPTから不正な応答を受信しました。', error);
  }
  const root = unknownRecord(payload);
  if (root === null || typeof root.type !== 'string')
    throw invalidResponse('ChatGPTから不正な応答を受信しました。');
  if (
    root.type === 'response.output_text.delta' &&
    typeof root.delta === 'string' &&
    root.delta.length > 0
  )
    return [{ type: 'text-delta', text: root.delta }];
  if (
    (root.type === 'response.reasoning_summary_text.delta' ||
      root.type === 'response.reasoning_text.delta') &&
    typeof root.delta === 'string' &&
    root.delta.length > 0
  )
    return [{ type: 'thinking-delta', text: root.delta }];
  if (root.type === 'response.completed') {
    const usage = unknownRecord(unknownRecord(root.response)?.usage);
    return [
      {
        type: 'usage',
        inputTokens: recordNumber(usage?.input_tokens),
        outputTokens: recordNumber(usage?.output_tokens),
      },
    ];
  }
  if (
    root.type === 'response.failed' ||
    root.type === 'response.incomplete' ||
    root.type === 'error'
  )
    throw invalidResponse('ChatGPTが応答を完了できませんでした。');
  return [];
}

class ChatGptSession implements LlmSession {
  readonly #body: ReadableStream<Uint8Array>;
  readonly #controller: AbortController;
  readonly #cleanup: () => void;
  #consumed = false;
  #closed = false;
  constructor(body: ReadableStream<Uint8Array>, controller: AbortController, cleanup: () => void) {
    this.#body = body;
    this.#controller = controller;
    this.#cleanup = cleanup;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<LlmStreamEvent> {
    if (this.#consumed) throw invalidResponse('ChatGPTの応答は一度だけ読み取れます。');
    this.#consumed = true;
    try {
      for await (const data of streamSseData(this.#body, this.#controller.signal)) {
        if (data.trim() === '[DONE]') return;
        yield* parseStreamEvent(data);
      }
    } catch (error) {
      if (this.#controller.signal.aborted || isAbortError(error))
        throw new DOMException('ChatGPT request cancelled.', 'AbortError');
      if (error instanceof LlmProviderError) throw error;
      throw invalidResponse('ChatGPTから不正な応答を受信しました。', error);
    } finally {
      this.#cleanup();
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanup();
    this.#controller.abort();
    await this.#body.cancel().catch(() => undefined);
  }
}

export interface ChatGptClientConfig {
  readonly model: string;
  readonly credential: string;
  readonly onCredentialChanged: (credential: string) => void;
  readonly fetch?: FetchLike;
}

function responseInput(messages: readonly LlmMessage[]): readonly Record<string, unknown>[] {
  return messages.flatMap<Record<string, unknown>>((message) =>
    message.role === 'system'
      ? []
      : [
          {
            role: message.role,
            content: [
              {
                type: message.role === 'assistant' ? 'output_text' : 'input_text',
                text: message.content,
              },
            ],
          },
        ],
  );
}

export class ChatGptClient implements LlmClient {
  readonly #model: ChatGptModel;
  readonly #fetch: FetchLike;
  readonly #onCredentialChanged: (credential: string) => void;
  #credential: ChatGptCredential;
  #refreshing: Promise<ChatGptCredential> | null = null;
  constructor(config: ChatGptClientConfig) {
    const model = CHATGPT_MODELS.find((candidate) => candidate.id === config.model);
    if (model === undefined)
      throw new LlmProviderError(`ChatGPTで使用できないモデルです: ${config.model}`, {
        code: 'invalid-configuration',
        retryable: false,
      });
    this.#model = model;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#credential = parseChatGptCredential(config.credential);
    this.#onCredentialChanged = config.onCredentialChanged;
  }
  async #renew(signal: AbortSignal): Promise<ChatGptCredential> {
    if (this.#refreshing === null) {
      this.#refreshing = refreshCredential(this.#credential, this.#fetch, signal)
        .then((credential) => {
          this.#credential = credential;
          this.#onCredentialChanged(serializeChatGptCredential(credential));
          return credential;
        })
        .finally(() => {
          this.#refreshing = null;
        });
    }
    return this.#refreshing;
  }
  async #send(
    request: LlmRequest,
    controller: AbortController,
    forceRefresh = false,
  ): Promise<Response> {
    if (forceRefresh || this.#credential.expires <= Date.now() + REFRESH_SKEW_MS)
      await this.#renew(controller.signal);
    const systemPrompt = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const body: Record<string, unknown> = {
      model: this.#model.id,
      stream: true,
      store: false,
      instructions: systemPrompt.length > 0 ? systemPrompt : 'You are a helpful assistant.',
      input: responseInput(request.messages),
      reasoning: { summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    };
    // ChatGPTのCodex endpointは公開Responses APIより受理する項目が狭い。
    // JSON出力は上位のsystem promptで指定済みなので、400になるsampling・出力制限・
    // json_object指定を送らず、Codex公式クライアントと同じ最小payloadに揃える。
    try {
      return await this.#fetch(RESPONSES_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#credential.access}`,
          'ChatGPT-Account-Id': this.#credential.accountId,
          originator: 'fumu',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error))
        throw new DOMException('ChatGPT request cancelled.', 'AbortError');
      throw new LlmProviderError('ChatGPTへ接続できませんでした。', {
        code: 'network',
        retryable: true,
        cause: error,
      });
    }
  }
  async createSession(request: LlmRequest): Promise<LlmSession> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = (): void => request.signal?.removeEventListener('abort', abort);
    try {
      let response = await this.#send(request, controller);
      if (response.status === 401) {
        await readBoundedResponseText(response, undefined, controller.signal).catch(
          (error: unknown) => {
            if (controller.signal.aborted) throw error;
            return '';
          },
        );
        response = await this.#send(request, controller, true);
      }
      if (!response.ok) {
        await readBoundedResponseText(response, undefined, controller.signal).catch(
          (error: unknown) => {
            if (controller.signal.aborted) throw error;
            return '';
          },
        );
        throw statusError(response.status);
      }
      if (response.body === null) {
        cleanup();
        throw invalidResponse('ChatGPTの応答にストリームがありません。');
      }
      return new ChatGptSession(response.body, controller, cleanup);
    } catch (error) {
      cleanup();
      if (controller.signal.aborted || isAbortError(error))
        throw new DOMException('ChatGPT request cancelled.', 'AbortError');
      if (error instanceof LlmProviderError) throw error;
      throw new LlmProviderError('ChatGPTへ接続できませんでした。', {
        code: 'provider-unavailable',
        retryable: true,
        cause: error,
      });
    }
  }
}
