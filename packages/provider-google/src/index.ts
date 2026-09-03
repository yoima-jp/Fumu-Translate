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

export interface GoogleGeminiConfig {
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

const API_VERSION = 'v1beta';

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

function acceptsSamplingTemperature(model: string): boolean {
  // Gemini 3.8ではサンプリング値が廃止され、temperatureを含めると
  // INVALID_ARGUMENTになる。モデル側の既定値を使い、従来モデルとの互換性は保つ。
  return !/^gemini-3\.8-flash(?:-|$)/u.test(model);
}

/**
 * GeminiのfinishReasonは停止理由と安全フィルタの両方を表す。
 * 正常終了以外は理由に応じてエラーへ変換する。MALFORMED_FUNCTION_CALLのように
 * テキストが失われていないケースは一旦正常扱いとし、危険度の高いものだけ厳格に弾く。
 */
function finishReasonError(reason: string): LlmProviderError | null {
  switch (reason) {
    case 'STOP':
      return null;
    case 'MAX_TOKENS':
      return new LlmProviderError('The provider stopped because the output limit was reached.', {
        code: 'invalid-response',
        retryable: true,
      });
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'RECITATION':
      return new LlmProviderError('The provider omitted the result because of a content filter.', {
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

function parseGeminiEvent(data: string): readonly LlmStreamEvent[] {
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

  const error = unknownRecord(root.error);
  if (error !== null) {
    const message = typeof error.message === 'string' ? error.message : 'Provider stream error.';
    const numericCode = finiteNumber(error.code);
    throw new LlmProviderError(message, {
      code: 'provider-unavailable',
      // Geminiストリーム中のerrorオブジェクトではHTTP相当値はcodeに入り、
      // statusはRESOURCE_EXHAUSTEDなどの文字列になる。文字列比較だけに依存すると
      // API追加時に再試行可否を誤るため、数値codeを優先する。
      // 429/5xx相当のみ一時的とみなし、それ以外は再試行で形状が変わらないものとして扱う。
      retryable: numericCode === 429 || (numericCode !== null && numericCode >= 500),
    });
  }

  const events: LlmStreamEvent[] = [];
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const candidate = unknownRecord(candidates[0]);
  if (candidate !== null) {
    const finishReason = typeof candidate.finishReason === 'string' ? candidate.finishReason : null;
    if (finishReason !== null) {
      const finishError = finishReasonError(finishReason);
      if (finishError !== null) {
        throw finishError;
      }
    }

    const content = unknownRecord(candidate.content);
    const parts = content !== null && Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      const partRecord = unknownRecord(part);
      // 思考対応モデルは回答とは別にthoughtパートを返す場合がある。
      // 翻訳JSONへ推論文を混ぜると後段のJSON解析が失敗するため、回答本文だけを流す。
      if (partRecord?.thought === true) {
        continue;
      }
      const text = partRecord?.text;
      if (typeof text === 'string' && text.length > 0) {
        events.push({ type: 'text-delta', text });
      }
    }
  }

  const usageMetadata = unknownRecord(root.usageMetadata);
  if (usageMetadata !== null) {
    events.push({
      type: 'usage',
      inputTokens: finiteNumber(usageMetadata.promptTokenCount),
      outputTokens: finiteNumber(usageMetadata.candidatesTokenCount),
    });
  }

  return events;
}

class GeminiSession implements LlmSession {
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
        yield* parseGeminiEvent(data);
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

export class GoogleGeminiClient implements LlmClient {
  readonly #config: NormalizedConfig;

  constructor(config: GoogleGeminiConfig) {
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

    // キーは x-goog-api-key ヘッダで送る。URLクエリへは載せない(ログに残るため)。
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-goog-api-key': this.#config.apiKey ?? '',
    };

    // すでに中断されている要求はネットワークに触れずに即座に失敗させる。
    // これによりテスト容易性と、無駄な課金対象リクエストの防止の両方を確保する。
    if (abortController.signal.aborted) {
      removeExternalAbortListener();
      throw new DOMException('The provider request was cancelled.', 'AbortError');
    }

    const systemTexts: string[] = [];
    const contents: { role: string; parts: { text: string }[] }[] = [];
    for (const message of request.messages) {
      if (message.role === 'system') {
        systemTexts.push(message.content);
      } else {
        contents.push({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        });
      }
    }

    const body: Record<string, unknown> = {};
    if (systemTexts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
    }
    body.contents = contents;

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined && acceptsSamplingTemperature(this.#config.model)) {
      generationConfig.temperature = request.temperature;
    }
    if (request.maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxOutputTokens;
    }
    if (request.responseFormat === 'json-object') {
      generationConfig.responseMimeType = 'application/json';
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
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
        // エラー本文は診断用に先頭2KBだけ。キーはヘッダ経由でしか送らない。
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

    return new GeminiSession(response.body, abortController, removeExternalAbortListener);
  }
}

function normalizeConfig(config: GoogleGeminiConfig): NormalizedConfig {
  const configuredModel = config.model.trim();
  // Googleのモデル一覧APIは`models/gemini-...`形式を返す一方、生成APIのURL側にも
  // `models/`が含まれる。設定欄へどちらの表記を貼っても二重化しないよう正規化する。
  const model = configuredModel.startsWith('models/')
    ? configuredModel.slice('models/'.length)
    : configuredModel;
  if (model.length === 0 || model.length > 128) {
    throw configurationError('A model name of 1-128 characters is required.');
  }

  const apiKey = config.apiKey?.trim() ?? null;
  if (config.apiKey !== undefined && apiKey?.length === 0) {
    throw configurationError('The API key must not be blank.');
  }

  // モデル名はURLパスに含まれるためencodeURIComponentで安全化する。
  const encodedModel = encodeURIComponent(model);
  const endpoint = new URL(
    `https://generativelanguage.googleapis.com/${API_VERSION}/models/${encodedModel}:streamGenerateContent?alt=sse`,
  );

  return {
    endpoint,
    model,
    apiKey,
    fetch: config.fetch ?? globalThis.fetch,
  };
}
