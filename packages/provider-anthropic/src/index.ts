import { readBoundedResponseText, streamSseData } from '@fumu/http-sse';
import {
  createProviderHttpStatusError as statusError,
  LlmProviderError,
  type FetchLike,
  type LlmClient,
  type LlmRequest,
  type LlmSession,
  type LlmStreamEvent,
} from '@fumu/llm-core';

export type { FetchLike } from '@fumu/llm-core';

export interface AnthropicConfig {
  readonly model: string;
  readonly apiKey?: string;
  readonly fetch?: FetchLike;
}

interface NormalizedConfig {
  readonly endpoint: URL;
  readonly model: string;
  readonly apiKey: string | null;
  readonly fetch: FetchLike;
}

const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

function configurationError(message: string, cause?: unknown): LlmProviderError {
  return new LlmProviderError(message, {
    code: 'invalid-configuration',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

function providerPayloadError(message: string): LlmProviderError {
  return new LlmProviderError(message, {
    code: 'invalid-response',
    retryable: true,
  });
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finishReasonError(reason: string): LlmProviderError | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return null;
    case 'max_tokens':
      return new LlmProviderError('The provider stopped because the output limit was reached.', {
        code: 'invalid-response',
        retryable: true,
      });
    case 'refusal':
      return new LlmProviderError('The provider refused the output for safety reasons.', {
        code: 'permission',
        retryable: false,
      });
    default:
      return new LlmProviderError(`Unexpected provider finish reason: ${reason}`, {
        code: 'invalid-response',
        retryable: false,
      });
  }
}

function parseAnthropicEvent(data: string): readonly LlmStreamEvent[] {
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
  // JSON配列やプリミティブも公式SSE仕様のオブジェクト形式から外れるため拒否する。
  if (root === null || Array.isArray(payload)) {
    throw providerPayloadError('The provider SSE payload is not an object.');
  }

  const rootType = typeof root.type === 'string' ? root.type : null;
  if (rootType === 'error') {
    const error = unknownRecord(root.error);
    const message = typeof error?.message === 'string' ? error.message : 'Provider stream error.';
    throw new LlmProviderError(message, {
      code: 'provider-unavailable',
      retryable: error?.type === 'overloaded_error',
    });
  }

  const events: LlmStreamEvent[] = [];

  if (rootType === 'message_start') {
    // message_startのusageはmessageオブジェクト内にネストされる。
    const startMessage = unknownRecord(root.message);
    const startUsage = unknownRecord(startMessage?.usage);
    if (startUsage !== null) {
      events.push({
        type: 'usage',
        inputTokens: finiteNumber(startUsage.input_tokens),
        outputTokens: finiteNumber(startUsage.output_tokens),
      });
    }
  }

  if (rootType === 'content_block_delta') {
    const delta = unknownRecord(root.delta);
    if (delta !== null) {
      const text = delta.text;
      const thinking = delta.thinking;
      if (typeof text === 'string' && text.length > 0) {
        events.push({ type: 'text-delta', text });
      }
      // 拡張思考は thinking_delta として text フィールドに載る。
      // content_block_delta イベントの delta.type が thinking_delta の場合のみ thinking として扱う。
      if (delta.type === 'thinking_delta' && typeof thinking === 'string' && thinking.length > 0) {
        events.push({ type: 'thinking-delta', text: thinking });
      }
    }
  }

  if (rootType === 'message_delta') {
    const delta = unknownRecord(root.delta);
    const stopReason = typeof delta?.stop_reason === 'string' ? delta.stop_reason : null;
    if (stopReason !== null) {
      const finishError = finishReasonError(stopReason);
      if (finishError !== null) {
        throw finishError;
      }
    }
  }

  const usage = unknownRecord(root.usage);
  if (usage !== null) {
    events.push({
      type: 'usage',
      inputTokens: finiteNumber(usage.input_tokens),
      outputTokens: finiteNumber(usage.output_tokens),
    });
  }

  return events;
}

class AnthropicSession implements LlmSession {
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
        yield* parseAnthropicEvent(data);
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

export class AnthropicClient implements LlmClient {
  readonly #config: NormalizedConfig;

  constructor(config: AnthropicConfig) {
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

    // APIキーは x-api-key ヘッダにのみ載せる。エラー本文やログへは出力しない。
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': this.#config.apiKey ?? '',
      'anthropic-version': API_VERSION,
    };

    // すでに中断されている要求はネットワークに触れずに即座に失敗させる。
    // これによりテスト容易性と、無駄な課金対象リクエストの防止の両方を確保する。
    if (abortController.signal.aborted) {
      removeExternalAbortListener();
      throw new DOMException('The provider request was cancelled.', 'AbortError');
    }

    const systemTexts: string[] = [];
    const turns: { role: string; content: string }[] = [];
    for (const message of request.messages) {
      if (message.role === 'system') {
        systemTexts.push(message.content);
      } else {
        turns.push({ role: message.role, content: message.content });
      }
    }

    const body: Record<string, unknown> = {
      model: this.#config.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      messages: turns,
    };
    if (systemTexts.length > 0) {
      body.system = systemTexts.join('\n\n');
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
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
        // エラー本文は診断用に先頭2KBだけ。キーはヘッダ経由でしか送らず、
        // 本文側へ再掲しないことで露出面を増やさない。
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

    return new AnthropicSession(response.body, abortController, removeExternalAbortListener);
  }
}

/**
 * Messages APIはsystemを独立フィールドで要求するため、ここでも役割分離を検証できる。
 * URLは公式HTTPSエンドポイントに固定し、呼び出し側から差し替え不能にする。
 */
function normalizeConfig(config: AnthropicConfig): NormalizedConfig {
  const model = config.model.trim();
  if (model.length === 0 || model.length > 64) {
    throw configurationError('A model name of 1-64 characters is required.');
  }

  const apiKey = config.apiKey?.trim() ?? null;
  if (config.apiKey !== undefined && apiKey?.length === 0) {
    throw configurationError('The API key must not be blank.');
  }

  // エンドポイントは公式APIに固定する。HTTPS強制と資格情報混入の排除はこの固定で保証する。
  const endpoint = new URL('https://api.anthropic.com/v1/messages');

  return {
    endpoint,
    model,
    apiKey,
    fetch: config.fetch ?? globalThis.fetch,
  };
}
