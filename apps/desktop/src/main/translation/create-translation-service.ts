import type { LlmClient } from '@fumu/llm-core';
import log from 'electron-log/main';
import { AnthropicClient } from '@fumu/provider-anthropic';
import { ChatGptClient } from '@fumu/provider-chatgpt';
import { GoogleGeminiClient } from '@fumu/provider-google';
import { OpenAiCompatibleClient } from '@fumu/provider-openai-compatible';
import {
  StreamingFollowUpService,
  StreamingTranslationService,
  UnconfiguredFollowUpService,
  UnconfiguredTranslationService,
  type FollowUpEvent,
  type FollowUpRequest,
  type FollowUpService,
  type TranslationEvent,
  type TranslationRequest,
  type TranslationService,
} from '@fumu/translation-core';
import type {
  CompletedRuntimeModel,
  ProviderActivationPort,
  RuntimeModel,
} from '../settings/settings-service';

type DisposableLlmClient = LlmClient & { dispose?: () => Promise<void> };

interface ServicePair {
  readonly translation: TranslationService;
  readonly followUp: FollowUpService;
  readonly client: DisposableLlmClient | null;
  readonly providerName: string | null;
  readonly modelName: string | null;
  readonly providerId: string | null;
}

function nonBlank(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length === 0 ? null : normalized;
}

function servicesForClient(
  client: DisposableLlmClient,
  providerName: string,
  modelName: string,
  providerId: string | null,
): ServicePair {
  return {
    translation: new StreamingTranslationService(client),
    followUp: new StreamingFollowUpService(client),
    client,
    providerName,
    modelName,
    providerId,
  };
}

function unconfiguredServices(): ServicePair {
  return {
    translation: new UnconfiguredTranslationService(),
    followUp: new UnconfiguredFollowUpService(),
    client: null,
    providerName: null,
    modelName: null,
    providerId: null,
  };
}

function environmentServices(environment: Readonly<NodeJS.ProcessEnv>): ServicePair {
  const baseUrl = nonBlank(environment.FUMU_OPENAI_BASE_URL);
  const model = nonBlank(environment.FUMU_OPENAI_MODEL);
  if (baseUrl === null || model === null) return unconfiguredServices();
  const apiKey = nonBlank(environment.FUMU_OPENAI_API_KEY);
  return servicesForClient(
    new OpenAiCompatibleClient({
      baseUrl,
      model,
      ...(apiKey === null ? {} : { apiKey }),
      includeUsage: environment.FUMU_OPENAI_INCLUDE_USAGE === 'true',
      supportsJsonObjectResponse: environment.FUMU_OPENAI_JSON_MODE !== 'false',
    }),
    '環境変数',
    model,
    null,
  );
}

function withPath(baseUrl: string, path: string): string {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalized).toString();
}

export type ModelClientFactory = (model: RuntimeModel) => DisposableLlmClient;

const modelClient: ModelClientFactory = ({ provider, modelId, apiKey, updateCredential }) => {
  const keyed = apiKey === null ? {} : { apiKey };
  switch (provider.kind) {
    case 'chatgpt':
      if (apiKey === null) throw new Error('ChatGPTの認証情報がありません。');
      if (updateCredential === undefined) throw new Error('ChatGPTの認証情報を更新できません。');
      return new ChatGptClient({
        model: modelId,
        credential: apiKey,
        onCredentialChanged: updateCredential,
      });
    case 'anthropic':
      return new AnthropicClient({ model: modelId, ...keyed });
    case 'google':
      return new GoogleGeminiClient({ model: modelId, ...keyed });
    case 'openai':
      return new OpenAiCompatibleClient({
        baseUrl: 'https://api.openai.com/v1/',
        model: modelId,
        ...keyed,
        includeUsage: true,
        supportsJsonObjectResponse: true,
        maxOutputTokensParameter: 'max_completion_tokens',
      });
    case 'groq':
      return new OpenAiCompatibleClient({
        baseUrl: 'https://api.groq.com/openai/v1/',
        model: modelId,
        ...keyed,
        includeUsage: true,
        supportsJsonObjectResponse: true,
      });
    case 'openrouter':
      return new OpenAiCompatibleClient({
        baseUrl: 'https://openrouter.ai/api/v1/',
        model: modelId,
        ...keyed,
        includeUsage: true,
        supportsJsonObjectResponse: true,
      });
    case 'deepinfra':
      return new OpenAiCompatibleClient({
        baseUrl: 'https://api.deepinfra.com/v1/openai/',
        model: modelId,
        ...keyed,
        includeUsage: true,
        supportsJsonObjectResponse: true,
      });
    case 'mistral':
      return new OpenAiCompatibleClient({
        baseUrl: 'https://api.mistral.ai/v1/',
        model: modelId,
        ...keyed,
        includeUsage: true,
        supportsJsonObjectResponse: true,
      });
    case 'ollama-cloud':
      return new OpenAiCompatibleClient({
        baseUrl: 'https://ollama.com/v1/',
        model: modelId,
        ...keyed,
        includeUsage: false,
        supportsJsonObjectResponse: true,
      });
    case 'ollama':
      return new OpenAiCompatibleClient({
        baseUrl: withPath(provider.baseUrl, 'v1/'),
        model: modelId,
        ...keyed,
        includeUsage: false,
        supportsJsonObjectResponse: true,
      });
    case 'lm-studio':
      return new OpenAiCompatibleClient({
        baseUrl: provider.baseUrl,
        model: modelId,
        ...keyed,
        includeUsage: false,
        supportsJsonObjectResponse: true,
      });
    case 'custom-openai-compatible':
      return new OpenAiCompatibleClient({
        baseUrl: provider.baseUrl,
        model: modelId,
        ...keyed,
        includeUsage: provider.includeUsage,
        supportsJsonObjectResponse: provider.supportsJsonObjectResponse,
      });
  }
};

function shouldFallback(event: TranslationEvent | FollowUpEvent): boolean {
  // `retryable` describes whether retrying the same Provider is sensible. The
  // configured list can contain a different Provider or model, so authentication,
  // permission, content-filter, and response-shape failures must not prevent the
  // next independent candidate from being attempted.
  return event.type === 'failed';
}

const DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS = 30_000;
const logger = log.scope('translation-registry');

async function nextEventWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<IteratorResult<T> | null> {
  let timer: NodeJS.Timeout | null = null;
  const next = iterator.next();
  // A provider that ignores AbortSignal must not create an unhandled rejection
  // after the registry has already continued with the next configured model.
  void next.catch(() => undefined);
  const timed = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(null), timeoutMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([next, timed]);
    if (result === null) {
      controller.abort(new DOMException('Model attempt timed out.', 'TimeoutError'));
    }
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export class LanguageServiceRegistry
  implements TranslationService, FollowUpService, ProviderActivationPort
{
  readonly #environmentFallback: ServicePair;
  readonly #modelClientFactory: ModelClientFactory;
  readonly #modelAttemptTimeoutMs: number;
  readonly #pendingDisposals = new Set<Promise<void>>();
  readonly #queuedClients = new WeakSet<object>();
  readonly #disposalErrors: unknown[] = [];
  readonly #completedModels = new Map<string, CompletedRuntimeModel>();
  #active: readonly ServicePair[];
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    _agentCwd: string,
    modelClientFactory: ModelClientFactory = modelClient,
    modelAttemptTimeoutMs = DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(modelAttemptTimeoutMs) || modelAttemptTimeoutMs <= 0) {
      throw new TypeError('Model attempt timeout must be a positive safe integer.');
    }
    this.#environmentFallback = environmentServices(environment);
    this.#active = this.#environmentFallback.client === null ? [] : [this.#environmentFallback];
    this.#modelClientFactory = modelClientFactory;
    this.#modelAttemptTimeoutMs = modelAttemptTimeoutMs;
  }

  get configured(): boolean {
    return this.#active.length > 0;
  }
  get activeProviderName(): string | null {
    return this.#active[0]?.providerName ?? null;
  }
  get activeModelName(): string | null {
    return this.#active[0]?.modelName ?? null;
  }

  consumeCompletedModel(requestId: string): CompletedRuntimeModel | null {
    const completed = this.#completedModels.get(requestId) ?? null;
    this.#completedModels.delete(requestId);
    return completed;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    try {
      if (this.#active.length === 0) {
        yield* new UnconfiguredTranslationService().translate(request);
        return;
      }
      // 設定変更が処理中に行われても、要求開始時の候補順と履歴帰属を固定する。
      const candidates = this.#active;
      let started = false;
      let sequence = 0;
      for (let index = 0; index < candidates.length; index += 1) {
        const service = candidates[index]!;
        const attemptController = new AbortController();
        const abortAttempt = (): void => attemptController.abort(request.signal?.reason);
        request.signal?.addEventListener('abort', abortAttempt, { once: true });
        if (request.signal?.aborted) abortAttempt();
        const iterator = service.translation
          .translate({ ...request, signal: attemptController.signal })
          [Symbol.asyncIterator]();
        let fallback = false;
        try {
          while (true) {
            const next = await nextEventWithTimeout(
              iterator,
              this.#modelAttemptTimeoutMs,
              attemptController,
            );
            if (next === null) {
              logger.warn('Translation model attempt timed out', {
                providerName: service.providerName,
                modelName: service.modelName,
                timeoutMs: this.#modelAttemptTimeoutMs,
              });
              void iterator.return?.().catch(() => undefined);
              if (request.signal?.aborted) {
                yield { type: 'cancelled', requestId: request.requestId };
                return;
              }
              if (index + 1 < candidates.length) {
                fallback = true;
                yield {
                  type: 'started',
                  requestId: request.requestId,
                  startedAt: Date.now(),
                };
              } else {
                yield {
                  type: 'failed',
                  requestId: request.requestId,
                  code: 'network',
                  message: 'モデルからの応答がありませんでした。',
                  retryable: true,
                };
              }
              break;
            }
            if (next.done) break;
            const event = next.value;
            if (event.type === 'started') {
              if (!started) {
                started = true;
                yield event;
              }
              continue;
            }
            if (event.type === 'snapshot') {
              sequence += 1;
              yield { ...event, sequence };
              continue;
            }
            if (
              event.type === 'completed' &&
              service.providerName !== null &&
              service.modelName !== null
            ) {
              logger.info('Translation model attempt completed', {
                providerName: service.providerName,
                modelName: service.modelName,
              });
              this.#completedModels.set(request.requestId, {
                providerId: service.providerId,
                providerName: service.providerName,
                modelId: service.modelName,
              });
            }
            if (event.type === 'failed') {
              // Provider response bodies and source text are intentionally omitted.
              // The public error code is sufficient to diagnose routing without
              // leaking credentials or selected content into persistent logs.
              logger.warn('Translation model attempt failed', {
                providerName: service.providerName,
                modelName: service.modelName,
                code: event.code,
                retryable: event.retryable,
              });
            }
            if (shouldFallback(event) && index + 1 < candidates.length) {
              fallback = true;
              // Providerを切り替えると同じrequestIdでも応答本文は別物になる。
              // 直前のProviderの途中スナップショットを残したまま次の応答を重ねると、
              // 解説や翻訳が途中で別内容へ変わったように見えるため、表示を新しい試行へ戻す。
              yield {
                type: 'started',
                requestId: request.requestId,
                startedAt: Date.now(),
              };
              // This loop drives the iterator manually, so `break` does not perform
              // AsyncIteratorClose. Resume the suspended failure yield and let the
              // service run its `finally` block before opening the fallback session.
              await iterator.return?.();
              break;
            }
            yield event;
          }
        } finally {
          request.signal?.removeEventListener('abort', abortAttempt);
        }
        if (!fallback) return;
      }
    } finally {
      // Controllerが完了イベントを検証する直前に要求が無効化されても、要求単位の
      // 帰属情報をMapへ残さない。通常完了ではController側のconsumeが先に走る。
      this.#completedModels.delete(request.requestId);
    }
  }

  async *ask(request: FollowUpRequest): AsyncIterable<FollowUpEvent> {
    if (this.#active.length === 0) {
      yield* new UnconfiguredFollowUpService().ask(request);
      return;
    }
    const candidates = this.#active;
    let started = false;
    let sequence = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const service = candidates[index]!;
      const attemptController = new AbortController();
      const abortAttempt = (): void => attemptController.abort(request.signal?.reason);
      request.signal?.addEventListener('abort', abortAttempt, { once: true });
      if (request.signal?.aborted) abortAttempt();
      const iterator = service.followUp
        .ask({ ...request, signal: attemptController.signal })
        [Symbol.asyncIterator]();
      let fallback = false;
      try {
        while (true) {
          const next = await nextEventWithTimeout(
            iterator,
            this.#modelAttemptTimeoutMs,
            attemptController,
          );
          if (next === null) {
            logger.warn('Follow-up model attempt timed out', {
              providerName: service.providerName,
              modelName: service.modelName,
              timeoutMs: this.#modelAttemptTimeoutMs,
            });
            // A provider that ignores AbortSignal can also prevent `return()` from
            // settling. Start cleanup without making the fallback depend on it.
            void iterator.return?.().catch(() => undefined);
            if (request.signal?.aborted) {
              yield { type: 'cancelled', requestId: request.requestId };
              return;
            }
            if (index + 1 < candidates.length) {
              fallback = true;
            } else {
              yield {
                type: 'failed',
                requestId: request.requestId,
                code: 'network',
                message: 'モデルからの応答がありませんでした。',
                retryable: true,
              };
            }
            break;
          }
          if (next.done) break;
          const event = next.value;
          if (event.type === 'started') {
            if (!started) {
              started = true;
              yield event;
            }
            continue;
          }
          if (event.type === 'snapshot') {
            sequence += 1;
            yield { ...event, sequence };
            continue;
          }
          if (shouldFallback(event) && index + 1 < candidates.length) {
            fallback = true;
            // As above, a manual loop must explicitly close a generator suspended
            // at its failure event so the provider session reaches `finally`.
            await iterator.return?.();
            break;
          }
          yield event;
        }
      } finally {
        request.signal?.removeEventListener('abort', abortAttempt);
      }
      if (!fallback) return;
    }
  }

  validate(models: readonly RuntimeModel[]): void {
    this.#assertOpen();
    for (const model of models) this.#queueDisposal(this.#modelClientFactory(model));
  }

  configure(models: readonly RuntimeModel[]): void {
    this.#assertOpen();
    const next = models.map((model) =>
      servicesForClient(
        this.#modelClientFactory(model),
        model.provider.name,
        model.modelId,
        model.provider.id,
      ),
    );
    const previous = this.#active.filter((pair) => pair !== this.#environmentFallback);
    this.#active =
      next.length > 0
        ? next
        : this.#environmentFallback.client === null
          ? []
          : [this.#environmentFallback];
    for (const pair of previous) if (pair.client !== null) this.#queueDisposal(pair.client);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    for (const pair of this.#active) if (pair.client !== null) this.#queueDisposal(pair.client);
    if (this.#environmentFallback.client !== null)
      this.#queueDisposal(this.#environmentFallback.client);
    this.#active = [];
    this.#disposePromise = (async () => {
      while (this.#pendingDisposals.size > 0) await Promise.all([...this.#pendingDisposals]);
      if (this.#disposalErrors.length > 0) {
        throw new AggregateError(
          [...this.#disposalErrors],
          'One or more language provider clients could not be disposed.',
        );
      }
    })();
    return this.#disposePromise;
  }

  #queueDisposal(client: DisposableLlmClient): void {
    if (this.#queuedClients.has(client)) return;
    this.#queuedClients.add(client);
    let pending: Promise<void>;
    pending = Promise.resolve()
      .then(async () => client.dispose?.())
      .catch((error: unknown) => {
        this.#disposalErrors.push(error);
      })
      .finally(() => this.#pendingDisposals.delete(pending));
    this.#pendingDisposals.add(pending);
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('Language service registry is closed.');
  }
}

export function createLanguageServices(
  environment: Readonly<NodeJS.ProcessEnv>,
  agentCwd: string,
): LanguageServiceRegistry {
  return new LanguageServiceRegistry(environment, agentCwd);
}
