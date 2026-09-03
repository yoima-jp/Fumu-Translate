import { readBoundedResponseText, streamSseData } from '@fumu/http-sse';
import {
  createProviderHttpStatusError as statusError,
  LlmProviderError,
  isLoopbackHostname,
  type FetchLike,
  type LlmClient,
  type LlmRequest,
  type LlmSession,
  type LlmStreamEvent,
} from '@fumu/llm-core';

export type { FetchLike } from '@fumu/llm-core';

export interface OpenAiCompatibleConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly includeUsage?: boolean;
  readonly supportsJsonObjectResponse?: boolean;
  readonly maxOutputTokensParameter?: 'max_tokens' | 'max_completion_tokens';
  readonly fetch?: FetchLike;
}

interface NormalizedConfig {
  readonly endpoint: URL;
  readonly model: string;
  readonly apiKey: string | null;
  readonly includeUsage: boolean;
  readonly supportsJsonObjectResponse: boolean;
  readonly maxOutputTokensParameter: 'max_tokens' | 'max_completion_tokens';
  readonly fetch: FetchLike;
}

function configurationError(message: string, cause?: unknown): LlmProviderError {
  return new LlmProviderError(message, {
    code: 'invalid-configuration',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

function normalizeEndpoint(rawBaseUrl: string): URL {
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch (error) {
    throw configurationError('The OpenAI-compatible base URL is invalid.', error);
  }

  if (
    baseUrl.protocol !== 'https:' &&
    !(baseUrl.protocol === 'http:' && isLoopbackHostname(baseUrl.hostname))
  ) {
    throw configurationError('The base URL must use HTTPS, except for a loopback server.');
  }
  if (baseUrl.username.length > 0 || baseUrl.password.length > 0) {
    throw configurationError('Credentials must not be embedded in the base URL.');
  }
  if (baseUrl.search.length > 0 || baseUrl.hash.length > 0) {
    throw configurationError('The base URL must not contain a query or fragment.');
  }

  if (!baseUrl.pathname.endsWith('/')) {
    baseUrl.pathname += '/';
  }
  return new URL('chat/completions', baseUrl);
}

function normalizeConfig(config: OpenAiCompatibleConfig): NormalizedConfig {
  const model = config.model.trim();
  if (model.length === 0 || model.length > 500) {
    throw configurationError('A valid model name is required.');
  }

  const apiKey = config.apiKey?.trim() ?? null;
  if (config.apiKey !== undefined && apiKey?.length === 0) {
    throw configurationError('The API key must not be blank.');
  }

  return {
    endpoint: normalizeEndpoint(config.baseUrl),
    model,
    apiKey,
    includeUsage: config.includeUsage ?? false,
    supportsJsonObjectResponse: config.supportsJsonObjectResponse ?? true,
    maxOutputTokensParameter: config.maxOutputTokensParameter ?? 'max_tokens',
    fetch: config.fetch ?? globalThis.fetch,
  };
}

function providerPayloadError(message: string): LlmProviderError {
  return new LlmProviderError(message, {
    code: 'invalid-response',
    retryable: true,
  });
}

function finishReasonError(reason: string): LlmProviderError | null {
  switch (reason) {
    case 'stop':
      return null;
    case 'length':
      return new LlmProviderError('The provider stopped because the output limit was reached.', {
        code: 'invalid-response',
        retryable: true,
      });
    case 'content_filter':
      return new LlmProviderError('The provider omitted the result because of a content filter.', {
        code: 'permission',
        retryable: false,
      });
    case 'insufficient_system_resource':
      return new LlmProviderError('The provider did not have enough capacity.', {
        code: 'provider-unavailable',
        retryable: true,
      });
    default:
      return new LlmProviderError(`Unexpected provider finish reason: ${reason}`, {
        code: 'invalid-response',
        retryable: false,
      });
  }
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseProviderEvent(data: string): readonly LlmStreamEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    throw new LlmProviderError('The provider sent malformed SSE JSON.', {
      code: 'invalid-response',
      retryable: true,
      cause: error,
    });
  }

  const root = unknownRecord(payload);
  if (root === null) {
    throw providerPayloadError('The provider SSE payload is not an object.');
  }

  const error = unknownRecord(root.error);
  if (error !== null) {
    const message = typeof error.message === 'string' ? error.message : 'Provider stream error.';
    throw new LlmProviderError(message, {
      code: 'provider-unavailable',
      retryable: true,
    });
  }

  const events: LlmStreamEvent[] = [];
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = unknownRecord(choices[0]);
  if (typeof firstChoice?.finish_reason === 'string') {
    const finishError = finishReasonError(firstChoice.finish_reason);
    if (finishError !== null) {
      throw finishError;
    }
  }
  const delta = unknownRecord(firstChoice?.delta);
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    events.push({ type: 'thinking-delta', text: delta.reasoning_content });
  }
  if (typeof delta?.content === 'string' && delta.content.length > 0) {
    events.push({ type: 'text-delta', text: delta.content });
  }

  const usage = unknownRecord(root.usage);
  if (usage !== null) {
    events.push({
      type: 'usage',
      inputTokens: finiteNumber(usage.prompt_tokens ?? usage.input_tokens),
      outputTokens: finiteNumber(usage.completion_tokens ?? usage.output_tokens),
    });
  }
  return events;
}

class OpenAiCompatibleSession implements LlmSession {
  readonly #body: ReadableStream<Uint8Array>;
  readonly #abortController: AbortController;
  readonly #removeExternalAbortListener: () => void;
  #consumed = false;
  #closed = false;

  constructor(
    body: ReadableStream<Uint8Array>,
    abortController: AbortController,
    removeExternalAbortListener: () => void,
  ) {
    this.#body = body;
    this.#abortController = abortController;
    this.#removeExternalAbortListener = removeExternalAbortListener;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<LlmStreamEvent> {
    if (this.#consumed) {
      throw providerPayloadError('A provider stream cannot be consumed more than once.');
    }
    this.#consumed = true;

    try {
      for await (const data of streamSseData(this.#body, this.#abortController.signal)) {
        if (data.trim() === '[DONE]') {
          return;
        }
        yield* parseProviderEvent(data);
      }
    } finally {
      this.#removeExternalAbortListener();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#removeExternalAbortListener();
    this.#abortController.abort();
    await this.#body.cancel().catch(() => undefined);
  }
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly #config: NormalizedConfig;

  constructor(config: OpenAiCompatibleConfig) {
    this.#config = normalizeConfig(config);
  }

  async createSession(request: LlmRequest): Promise<LlmSession> {
    const abortController = new AbortController();
    const abortFromCaller = (): void => {
      abortController.abort(request.signal?.reason);
    };
    if (request.signal?.aborted === true) {
      abortFromCaller();
    } else {
      request.signal?.addEventListener('abort', abortFromCaller, { once: true });
    }
    const removeExternalAbortListener = (): void => {
      request.signal?.removeEventListener('abort', abortFromCaller);
    };

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    };
    if (this.#config.apiKey !== null) {
      headers.Authorization = `Bearer ${this.#config.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.#config.model,
      messages: request.messages,
      stream: true,
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxOutputTokens !== undefined) {
      body[this.#config.maxOutputTokensParameter] = request.maxOutputTokens;
    }
    if (request.responseFormat === 'json-object' && this.#config.supportsJsonObjectResponse) {
      body.response_format = { type: 'json_object' };
    }
    if (this.#config.includeUsage) {
      body.stream_options = { include_usage: true };
    }

    let response: Response;
    try {
      response = await this.#config.fetch(this.#config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
        redirect: 'error',
      });
    } catch (error) {
      removeExternalAbortListener();
      if (abortController.signal.aborted) {
        throw new DOMException('The provider request was cancelled.', 'AbortError');
      }
      throw new LlmProviderError('The provider could not be reached.', {
        code: 'network',
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      try {
        const details = await readBoundedResponseText(
          response,
          undefined,
          abortController.signal,
        ).catch((error: unknown) => {
          if (abortController.signal.aborted) throw error;
          return '';
        });
        throw statusError(response.status, details);
      } finally {
        removeExternalAbortListener();
      }
    }
    if (response.body === null) {
      removeExternalAbortListener();
      throw providerPayloadError('The provider response did not contain a stream.');
    }

    return new OpenAiCompatibleSession(response.body, abortController, removeExternalAbortListener);
  }
}

export function validateOpenAiCompatibleBaseUrl(baseUrl: string): string {
  return normalizeEndpoint(baseUrl).toString();
}
