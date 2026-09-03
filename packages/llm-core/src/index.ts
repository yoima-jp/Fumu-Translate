export type LlmMessageRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  readonly role: LlmMessageRole;
  readonly content: string;
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly responseFormat?: 'json-object';
  readonly signal?: AbortSignal;
}

export type LlmStreamEvent =
  | {
      readonly type: 'text-delta';
      readonly text: string;
    }
  | {
      readonly type: 'thinking-delta';
      readonly text: string;
    }
  | {
      readonly type: 'usage';
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    };

/**
 * Provider固有のstreamやprocessをTranslation Coreから隔離する境界。
 * close() はconsumerが途中でiterationを止めた場合にも資源を解放できなければならない。
 */
export interface LlmSession extends AsyncIterable<LlmStreamEvent> {
  close(): Promise<void>;
}

export interface LlmClient {
  createSession(request: LlmRequest): Promise<LlmSession>;
}

export type FetchLike = (input: string | URL, init: RequestInit) => Promise<Response>;

export type LlmProviderErrorCode =
  | 'invalid-configuration'
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'request-too-large'
  | 'provider-unavailable'
  | 'network'
  | 'invalid-response'
  | 'unknown';

export interface LlmProviderErrorOptions {
  readonly code: LlmProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly cause?: unknown;
}

export class LlmProviderError extends Error {
  readonly code: LlmProviderErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, options: LlmProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'LlmProviderError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
  }
}

/**
 * Standard HTTP providers share this classification so failover decisions do not
 * drift when a provider implementation changes independently.
 */
export function createProviderHttpStatusError(status: number, details: string): LlmProviderError {
  const options = (() => {
    if (status === 401) return { code: 'authentication' as const, retryable: false };
    if (status === 403) return { code: 'permission' as const, retryable: false };
    if (status === 413) return { code: 'request-too-large' as const, retryable: false };
    if (status === 429) return { code: 'rate-limit' as const, retryable: true };
    if (status >= 500) return { code: 'provider-unavailable' as const, retryable: true };
    return { code: 'unknown' as const, retryable: false };
  })();

  return new LlmProviderError(`Provider request failed (${String(status)}): ${details}`, {
    ...options,
    status,
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/**
 * HTTPを許可できるLoopback hostかをProviderと設定境界で共通判定する。
 * IPv4 loopbackは127.0.0.1だけでなく127.0.0.0/8全体である。
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === 'localhost' || normalized === '::1') return true;

  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}
