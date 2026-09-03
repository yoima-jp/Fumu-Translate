import {
  isAbortError,
  LlmProviderError,
  type LlmClient,
  type LlmRequest,
  type LlmSession,
} from '@fumu/llm-core';
import {
  MAX_TRANSLATION_SOURCE_CODE_POINTS,
  MAX_TRANSLATION_TRANSFORM_SOURCE_CODE_POINTS,
  translationOutputTokenBudget,
  validateInlineTranslationContexts,
  type TranslationEvent,
  type TranslationRequest,
  type TranslationResult,
  type TranslationService,
} from './contracts';
import {
  buildBackTranslationAssessmentMessages,
  parseBackTranslationAssessment,
} from './back-translation-assessment';
import { toPublicLlmError } from './errors';
import { buildTranslationMessages, translationLanguageDefaults } from './prompt';
import {
  parseFinalTranslationJson,
  parsePartialTranslationJson,
  recoverCompletedTranslation,
} from './streaming-json';

const MAX_STREAM_CHARACTERS = 1_000_000;

function operationSourceText(request: TranslationRequest): string {
  const operation = request.operation ?? 'translate';
  return operation === 'translate' || request.currentResult === undefined
    ? request.sourceText
    : request.currentResult.translation;
}

function validateRequest(request: TranslationRequest): TranslationRequest {
  const operation = request.operation ?? 'translate';
  if (operation !== 'translate' && request.currentResult === undefined) {
    throw new LlmProviderError('A completed translation is required for this operation.', {
      code: 'invalid-configuration',
      retryable: false,
    });
  }

  // 調整・戻し訳ではProviderへ送るのは元文ではなく現在の訳文なので、
  // 上限検証と出力予算も同じ実入力に揃える。ここがずれると長い訳文だけJSONが途中切れする。
  const sourceText = operationSourceText(request);
  const trimmed = sourceText.trim();
  const maximumCodePoints =
    operation === 'translate'
      ? MAX_TRANSLATION_SOURCE_CODE_POINTS
      : MAX_TRANSLATION_TRANSFORM_SOURCE_CODE_POINTS;
  if (trimmed.length === 0) {
    throw new LlmProviderError('Source text is empty.', {
      code: 'invalid-configuration',
      retryable: false,
    });
  }

  if (
    trimmed.length > maximumCodePoints * 2 ||
    (trimmed.length > maximumCodePoints && Array.from(trimmed).length > maximumCodePoints)
  ) {
    throw new LlmProviderError('Source text exceeds the supported size.', {
      code: 'request-too-large',
      retryable: false,
    });
  }

  const inlineContextValidation = validateInlineTranslationContexts(request.inlineContexts ?? []);
  if (!inlineContextValidation.success) {
    throw new LlmProviderError('Inline translation context is invalid.', {
      code:
        inlineContextValidation.error === 'empty' ? 'invalid-configuration' : 'request-too-large',
      retryable: false,
    });
  }
  return {
    ...request,
    inlineContexts: inlineContextValidation.value,
  };
}

function abortError(): DOMException {
  return new DOMException('The translation was cancelled.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  // AbortSignalは非同期iteration中に変化する。関数境界を設け、各await後に現在値を読む。
  if (signal?.aborted === true) {
    throw abortError();
  }
}

async function assessBackTranslation(
  client: LlmClient,
  request: TranslationRequest,
  result: TranslationResult,
): Promise<TranslationResult> {
  const unassessedResult: TranslationResult = {
    translation: result.translation,
    // 戻し訳生成側の自己評価や候補を判定結果として残さない。評価sessionが失敗した場合は
    // 本文と言語方向だけを返し、UIに「判定不能」と説明なしを表示させる。
    explanation: '',
    alternatives: [],
    alternativesNeeded: false,
    sourceLanguage: result.sourceLanguage,
    targetLanguage: result.targetLanguage,
  };
  let session: LlmSession | null = null;
  try {
    throwIfAborted(request.signal);
    session = await client.createSession({
      messages: buildBackTranslationAssessmentMessages(request, unassessedResult),
      temperature: 0,
      maxOutputTokens: 2_048,
      responseFormat: 'json-object',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    let response = '';
    for await (const event of session) {
      throwIfAborted(request.signal);
      if (event.type !== 'text-delta') continue;
      response += event.text;
      if (response.length > MAX_STREAM_CHARACTERS) {
        throw new LlmProviderError('The assessment response is too large.', {
          code: 'invalid-response',
          retryable: false,
        });
      }
    }
    const assessment = parseBackTranslationAssessment(response);
    return {
      ...unassessedResult,
      isNatural: assessment.translationNatural,
      meaningPreserved: assessment.meaningPreserved,
      explanation: assessment.explanation,
    };
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted === true) throw error;
    // 評価失敗で取得済みの戻し訳まで失わせない。UIは判定不能を明示し、再翻訳を強制しない。
    return unassessedResult;
  } finally {
    await session?.close().catch(() => undefined);
  }
}

export class StreamingTranslationService implements TranslationService {
  readonly #client: LlmClient;

  constructor(client: LlmClient) {
    this.#client = client;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    yield {
      type: 'started',
      requestId: request.requestId,
      startedAt: Date.now(),
    };

    let session: LlmSession | null = null;
    let streamedJson = '';
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let validatedRequest: TranslationRequest | null = null;
    try {
      validatedRequest = validateRequest(request);
      throwIfAborted(request.signal);

      const llmRequest: LlmRequest = {
        // Only the normalized result from the shared validator may cross the Provider boundary.
        // Otherwise whitespace/control padding and duplicates could bypass the semantic budget.
        messages: buildTranslationMessages(validatedRequest),
        temperature: 0.2,
        maxOutputTokens: translationOutputTokenBudget(operationSourceText(validatedRequest)),
        responseFormat: 'json-object',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      session = await this.#client.createSession(llmRequest);

      let sequence = 0;
      let previousSnapshot = '';

      for await (const event of session) {
        throwIfAborted(request.signal);

        if (event.type === 'usage') {
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          continue;
        }
        if (event.type !== 'text-delta' || event.text.length === 0) {
          continue;
        }

        streamedJson += event.text;
        if (streamedJson.length > MAX_STREAM_CHARACTERS) {
          throw new LlmProviderError('The streamed response is too large.', {
            code: 'invalid-response',
            retryable: false,
          });
        }

        const snapshot = parsePartialTranslationJson(streamedJson);
        if (snapshot === null) {
          continue;
        }
        const serialized = JSON.stringify(snapshot);
        if (serialized === previousSnapshot) {
          continue;
        }

        previousSnapshot = serialized;
        sequence += 1;
        yield {
          type: 'snapshot',
          requestId: request.requestId,
          sequence,
          value: snapshot,
        };
      }

      throwIfAborted(request.signal);

      const result = parseFinalTranslationJson(streamedJson, {
        ...translationLanguageDefaults(validatedRequest),
        operation: validatedRequest.operation ?? 'translate',
        forceLanguageDefaults: (validatedRequest.operation ?? 'translate') !== 'translate',
      });
      await session.close().catch(() => undefined);
      session = null;
      const completedResult =
        validatedRequest.operation === 'back-translate'
          ? await assessBackTranslation(this.#client, validatedRequest, result)
          : result;
      yield {
        type: 'completed',
        requestId: request.requestId,
        value: completedResult,
        completedAt: Date.now(),
        inputTokens,
        outputTokens,
      };
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted === true) {
        yield {
          type: 'cancelled',
          requestId: request.requestId,
        };
      } else {
        const recovered =
          validatedRequest === null
            ? null
            : recoverCompletedTranslation(streamedJson, {
                ...translationLanguageDefaults(validatedRequest),
                operation: validatedRequest.operation ?? 'translate',
                forceLanguageDefaults: (validatedRequest.operation ?? 'translate') !== 'translate',
              });
        if (recovered !== null && validatedRequest !== null) {
          await session?.close().catch(() => undefined);
          session = null;
          const completedResult =
            validatedRequest.operation === 'back-translate'
              ? await assessBackTranslation(this.#client, validatedRequest, recovered)
              : recovered;
          yield {
            type: 'completed',
            requestId: request.requestId,
            value: completedResult,
            completedAt: Date.now(),
            inputTokens,
            outputTokens,
          };
          return;
        }
        const publicError = toPublicLlmError(error);
        yield {
          type: 'failed',
          requestId: request.requestId,
          ...publicError,
          ...(request.debugMode && streamedJson.length > 0 ? { debugResponse: streamedJson } : {}),
        };
      }
    } finally {
      if (session !== null) {
        // close失敗で既に生成済みの翻訳結果を上書きしない。
        await session.close().catch(() => undefined);
      }
    }
  }
}

export class UnconfiguredTranslationService implements TranslationService {
  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    yield {
      type: 'started',
      requestId: request.requestId,
      startedAt: Date.now(),
    };
    yield {
      type: 'failed',
      requestId: request.requestId,
      code: 'provider-not-configured',
      message: '翻訳プロバイダーを設定してください。',
      retryable: false,
    };
  }
}
