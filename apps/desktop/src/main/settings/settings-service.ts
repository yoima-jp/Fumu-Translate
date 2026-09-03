import { randomUUID } from 'node:crypto';
import { isLoopbackHostname } from '@fumu/llm-core';
import { loginChatGpt as performChatGptLogin } from '@fumu/provider-chatgpt';
import { DEFAULT_UI_LOCALE, resolveUiLocale, type UiLocale } from '@fumu/i18n';
import type {
  FetchProviderModelsRequest,
  GeneralSettingsUpdate,
  ProviderConnection,
  ProviderConnectionDefinition,
  ProviderModel,
  SaveProviderRequest,
  SettingsSnapshot,
  UpdateUsedModelsRequest,
  UsedModelReference,
} from '../../shared/settings-contracts';
import type { StartupService } from '../os/windows/electron-startup-service';
import type {
  EncryptedSecretUpdate,
  SettingsRepository,
  StoredProviderConnection,
} from '../persistence/settings-repository';
import type { SecretStore } from '../security/electron-secret-store';
import { fetchProviderModels } from './provider-model-catalog';

export interface RuntimeModel {
  readonly provider: ProviderConnection;
  readonly modelId: string;
  readonly apiKey: string | null;
  /** OAuth更新でrefresh tokenがrotationされた場合に暗号化ストアへ戻す。 */
  readonly updateCredential?: (credential: string) => void;
}

export interface CompletedRuntimeModel {
  readonly providerId: string | null;
  readonly providerName: string;
  readonly modelId: string;
}

interface ChatGptLoginAttempt {
  readonly controller: AbortController;
  readonly completion: Promise<string>;
}

export interface ProviderActivationPort {
  readonly configured: boolean;
  readonly activeProviderName: string | null;
  readonly activeModelName: string | null;
  consumeCompletedModel(requestId: string): CompletedRuntimeModel | null;
  validate(models: readonly RuntimeModel[]): void;
  configure(models: readonly RuntimeModel[]): void;
}

const REQUIRED_API_KEY_KINDS = new Set<string>([
  'chatgpt',
  'openai',
  'anthropic',
  'google',
  'groq',
  'openrouter',
  'deepinfra',
  'mistral',
  'ollama-cloud',
]);

function requiresApiKey(provider: ProviderConnectionDefinition | ProviderConnection): boolean {
  return REQUIRED_API_KEY_KINDS.has(provider.kind);
}

function normalizedCredentialScope(
  provider: ProviderConnectionDefinition | ProviderConnection,
): string {
  if (!('baseUrl' in provider)) return provider.kind;
  return `${provider.kind}:${new URL(provider.baseUrl).origin.toLowerCase()}`;
}

function assertSafeConnection(provider: ProviderConnectionDefinition | ProviderConnection): void {
  if (!('baseUrl' in provider)) return;
  const url = new URL(provider.baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('接続先URLには認証情報、クエリ、フラグメントを含められません。');
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return;
  throw new Error('接続先はHTTPS、またはこの端末のHTTPアドレスを指定してください。');
}

function definitionWithId(
  definition: ProviderConnectionDefinition,
  id: string,
): ProviderConnectionDefinition & { readonly id: string } {
  return { ...definition, id };
}

export class SettingsService {
  readonly #repository: SettingsRepository;
  readonly #secrets: SecretStore;
  readonly #startup: StartupService;
  readonly #providers: ProviderActivationPort;
  readonly #listeners = new Set<(snapshot: SettingsSnapshot) => void>();
  readonly #stagedChatGptCredentials = new Map<string, string>();
  readonly #openExternal: (url: string) => void | Promise<void>;
  readonly #chatGptLogin: typeof performChatGptLogin;
  readonly #environmentUiLocale: UiLocale;
  #activeChatGptLogin: ChatGptLoginAttempt | null = null;
  #chatGptLoginTransition: Promise<void> = Promise.resolve();

  constructor(
    repository: SettingsRepository,
    secrets: SecretStore,
    startup: StartupService,
    providers: ProviderActivationPort,
    openExternal: (url: string) => void | Promise<void> = () => {
      throw new Error('ブラウザを開けませんでした。');
    },
    chatGptLogin: typeof performChatGptLogin = performChatGptLogin,
    environmentUiLocale: UiLocale = DEFAULT_UI_LOCALE,
  ) {
    this.#repository = repository;
    this.#secrets = secrets;
    this.#startup = startup;
    this.#providers = providers;
    this.#openExternal = openExternal;
    this.#chatGptLogin = chatGptLogin;
    this.#environmentUiLocale = environmentUiLocale;
  }

  initialize(): Error | null {
    try {
      this.#providers.configure(this.#runtimeModels(this.#repository.usedModels));
      return null;
    } catch (error) {
      try {
        // Startup can fail for a transient reason, such as credential decryption being
        // temporarily unavailable. Keep the user's persisted model order intact so a
        // later restart can recover without forcing them to rebuild the configuration.
        this.#providers.configure([]);
      } catch (recoveryError) {
        return new AggregateError([error, recoveryError], 'Provider設定の回復に失敗しました。');
      }
      return error instanceof Error ? error : new Error('Provider設定を読み込めませんでした。');
    }
  }

  get snapshot(): SettingsSnapshot {
    return {
      shortcut: this.#repository.shortcut,
      historyEnabled: this.#repository.historyEnabled,
      compactTranslation: this.#repository.compactTranslation,
      developerMode: this.#repository.developerMode,
      debugMode: this.#repository.debugMode,
      enterToSend: this.#repository.enterToSend,
      translationStyle: this.#repository.translationStyle,
      nativeLanguage: this.#repository.nativeLanguage,
      appearance: this.#repository.appearance,
      otherLanguageTarget: this.#repository.otherLanguageTarget,
      historyRetentionDays: this.#repository.historyRetentionDays,
      writingStyles: this.#repository.writingStyles,
      activeWritingStyleId: this.#repository.activeWritingStyleId,
      onboardingCompleted: this.#repository.onboardingCompleted,
      launchAtLogin: this.#startup.supported
        ? this.#startup.enabled
        : this.#repository.launchAtLogin,
      startupSupported: this.#startup.supported,
      providers: this.#repository.listProviders(),
      usedModels: this.#repository.usedModels,
    };
  }

  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setShortcut(shortcut: string): SettingsSnapshot {
    this.#repository.setShortcut(shortcut);
    return this.#publish();
  }

  updateGeneral(update: GeneralSettingsUpdate): SettingsSnapshot {
    const current = this.snapshot;
    const next = {
      historyEnabled: update.historyEnabled ?? current.historyEnabled,
      launchAtLogin: update.launchAtLogin ?? current.launchAtLogin,
      enterToSend: update.enterToSend ?? current.enterToSend,
      compactTranslation: update.compactTranslation ?? current.compactTranslation,
      developerMode: update.developerMode ?? current.developerMode,
      debugMode: update.debugMode ?? current.debugMode,
      translationStyle: update.translationStyle ?? current.translationStyle,
      nativeLanguage:
        update.nativeLanguage === undefined ? current.nativeLanguage : update.nativeLanguage,
      appearance: update.appearance ?? current.appearance,
      otherLanguageTarget: update.otherLanguageTarget ?? current.otherLanguageTarget,
      historyRetentionDays:
        update.historyRetentionDays === undefined
          ? current.historyRetentionDays
          : update.historyRetentionDays,
      writingStyles: update.writingStyles ?? current.writingStyles,
      activeWritingStyleId:
        update.activeWritingStyleId === undefined
          ? current.activeWritingStyleId
          : update.activeWritingStyleId,
      onboardingCompleted: update.onboardingCompleted ?? current.onboardingCompleted,
    };
    const previousStartup = this.#startup.enabled;
    const startupChanged = update.launchAtLogin !== undefined;
    try {
      if (startupChanged) this.#startup.setEnabled(next.launchAtLogin);
      this.#repository.setGeneralSettings(
        next.historyEnabled,
        next.launchAtLogin,
        next.nativeLanguage,
        next.appearance,
        next.otherLanguageTarget,
        next.historyRetentionDays,
        next.writingStyles,
        next.activeWritingStyleId,
        next.enterToSend,
        next.translationStyle,
        next.debugMode,
        next.onboardingCompleted,
        next.compactTranslation,
        next.developerMode,
      );
    } catch (error) {
      try {
        if (startupChanged) this.#startup.setEnabled(previousStartup);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          '設定の保存と自動起動の復元に失敗しました。',
        );
      }
      throw error;
    }
    return this.#publish();
  }

  async fetchModels(request: FetchProviderModelsRequest): Promise<readonly ProviderModel[]> {
    const existing =
      request.provider.id === null ? null : this.#repository.getProvider(request.provider.id);
    this.#assertSecretScope(request.provider, request.secret, existing);
    assertSafeConnection(request.provider);
    const apiKey = this.#candidateApiKey(request.provider, request.secret, existing);
    if (requiresApiKey(request.provider) && request.provider.kind !== 'chatgpt' && apiKey === null)
      throw new Error('API Keyを入力してください。');
    return fetchProviderModels(request.provider, apiKey);
  }

  async loginChatGpt(providerId: string): Promise<void> {
    let attempt!: ChatGptLoginAttempt;
    const transition = this.#chatGptLoginTransition.then(async () => {
      const previous = this.#activeChatGptLogin;
      if (previous !== null) {
        // 認証先のタブを閉じてもlocalhost callbackには通知されない。再操作時は
        // 古い待受の終了を待ってから次を開始し、同じportの競合を防ぐ。
        previous.controller.abort();
        await previous.completion.catch(() => undefined);
      }
      const controller = new AbortController();
      attempt = {
        controller,
        completion: Promise.resolve().then(() =>
          this.#chatGptLogin({
            openUrl: this.#openExternal,
            signal: controller.signal,
            locale:
              this.snapshot.nativeLanguage === null
                ? this.#environmentUiLocale
                : resolveUiLocale(this.snapshot.nativeLanguage),
          }),
        ),
      };
      this.#activeChatGptLogin = attempt;
    });
    this.#chatGptLoginTransition = transition.catch(() => undefined);
    await transition;

    let credential: string;
    try {
      credential = await attempt.completion;
    } finally {
      if (this.#activeChatGptLogin === attempt) this.#activeChatGptLogin = null;
    }
    // 未保存ProviderのtokenをRendererへ返さない。IDを知る同じ設定画面から保存された
    // ときだけ暗号化DBへ移し、保存前に画面を閉じたtokenはプロセス終了時に破棄する。
    this.#stagedChatGptCredentials.set(providerId, credential);
    const expiry = setTimeout(
      () => {
        // 再ログイン後に古いtimerが新しいcredentialを消さないよう、値も一致確認する。
        if (this.#stagedChatGptCredentials.get(providerId) === credential) {
          this.#stagedChatGptCredentials.delete(providerId);
        }
      },
      10 * 60 * 1000,
    );
    expiry.unref();
  }

  saveProvider(request: SaveProviderRequest): SettingsSnapshot {
    const id = request.provider.id ?? randomUUID();
    const definition = definitionWithId(request.provider, id);
    const existing = this.#repository.getProvider(id);
    this.#assertSecretScope(definition, request.secret, existing);
    assertSafeConnection(definition);
    const apiKey = this.#candidateApiKey(definition, request.secret, existing);
    if (requiresApiKey(definition) && apiKey === null)
      throw new Error(
        definition.kind === 'chatgpt'
          ? 'ChatGPTにログインしてください。'
          : 'API Keyを入力してください。',
      );
    const candidate = { ...definition, hasApiKey: apiKey !== null } as ProviderConnection;
    this.#assertEnabledModels(candidate);
    const references = this.#repository.usedModels.filter(
      (reference) =>
        reference.providerId !== id || candidate.enabledModelIds.includes(reference.modelId),
    );
    const runtime = this.#runtimeModels(references, candidate, apiKey);
    this.#providers.validate(runtime);
    this.#repository.saveProvider(
      definition,
      this.#encryptedSecretUpdate(definition, request.secret),
    );
    this.#stagedChatGptCredentials.delete(id);
    this.#providers.configure(runtime);
    return this.#publish();
  }

  deleteProvider(providerId: string): SettingsSnapshot {
    this.#stagedChatGptCredentials.delete(providerId);
    const references = this.#repository.usedModels.filter(
      (model) => model.providerId !== providerId,
    );
    const runtime = this.#runtimeModels(references);
    this.#providers.validate(runtime);
    this.#repository.deleteProvider(providerId);
    this.#providers.configure(runtime);
    return this.#publish();
  }

  updateUsedModels(request: UpdateUsedModelsRequest): SettingsSnapshot {
    const runtime = this.#runtimeModels(request.models);
    this.#providers.validate(runtime);
    this.#repository.setUsedModels(request.models);
    this.#providers.configure(runtime);
    return this.#publish();
  }

  #assertEnabledModels(provider: ProviderConnection): void {
    const ids = new Set(provider.models.map((model) => model.id));
    if (new Set(provider.enabledModelIds).size !== provider.enabledModelIds.length)
      throw new Error('有効Modelが重複しています。');
    if (provider.enabledModelIds.some((id) => !ids.has(id)))
      throw new Error('Model一覧にないModelは有効化できません。');
  }

  #runtimeModels(
    references: readonly UsedModelReference[],
    replacement?: ProviderConnection,
    replacementApiKey?: string | null,
  ): readonly RuntimeModel[] {
    const stored = new Map(
      this.#repository
        .listProviders()
        .map((provider) => [provider.id, this.#repository.getProvider(provider.id)!]),
    );
    return references.map((reference) => {
      const item =
        replacement?.id === reference.providerId ? null : stored.get(reference.providerId);
      const provider = replacement?.id === reference.providerId ? replacement : item?.provider;
      if (provider === undefined || !provider.enabledModelIds.includes(reference.modelId)) {
        throw new Error('使用Modelが見つからないか、無効化されています。');
      }
      const apiKey =
        replacement?.id === reference.providerId
          ? (replacementApiKey ?? null)
          : item?.encryptedSecret === null || item?.encryptedSecret === undefined
            ? null
            : this.#secrets.decrypt(item.encryptedSecret);
      if (requiresApiKey(provider) && apiKey === null)
        throw new Error(
          provider.kind === 'chatgpt'
            ? `${provider.name}にログインしてください。`
            : `${provider.name}のAPI Keyがありません。`,
        );
      return {
        provider,
        modelId: reference.modelId,
        apiKey,
        ...(provider.kind === 'chatgpt'
          ? {
              updateCredential: (credential: string): void => {
                this.#repository.updateProviderSecret(
                  provider.id,
                  this.#secrets.encrypt(credential),
                );
              },
            }
          : {}),
      };
    });
  }

  #encryptedSecretUpdate(
    provider: ProviderConnectionDefinition & { readonly id: string },
    secret: SaveProviderRequest['secret'],
  ): EncryptedSecretUpdate {
    const staged = this.#stagedChatGptCredentials.get(provider.id);
    if (provider.kind === 'chatgpt' && staged !== undefined) {
      return { action: 'replace', value: this.#secrets.encrypt(staged) };
    }
    switch (secret.action) {
      case 'preserve':
        return { action: 'preserve' };
      case 'clear':
        return { action: 'clear' };
      case 'replace':
        return { action: 'replace', value: this.#secrets.encrypt(secret.apiKey.trim()) };
    }
  }

  #candidateApiKey(
    provider: ProviderConnectionDefinition | ProviderConnection,
    secret: SaveProviderRequest['secret'],
    existing: StoredProviderConnection | null,
  ): string | null {
    const staged =
      provider.id === null ? undefined : this.#stagedChatGptCredentials.get(provider.id);
    if (provider.kind === 'chatgpt' && staged !== undefined) return staged;
    switch (secret.action) {
      case 'replace':
        return secret.apiKey.trim();
      case 'clear':
        return null;
      case 'preserve':
        return existing?.encryptedSecret === null || existing?.encryptedSecret === undefined
          ? null
          : this.#secrets.decrypt(existing.encryptedSecret);
    }
  }

  #assertSecretScope(
    provider: ProviderConnectionDefinition | ProviderConnection,
    secret: SaveProviderRequest['secret'],
    existing: StoredProviderConnection | null,
  ): void {
    if (secret.action !== 'preserve' || existing?.encryptedSecret == null) return;
    if (normalizedCredentialScope(existing.provider) !== normalizedCredentialScope(provider)) {
      // 保存済みKeyを別Providerや別originへ転用すると、Rendererからの改ざん要求だけで
      // 秘密値を外部へ送信できる。接続先変更時は明示的な再入力を要求する。
      throw new Error('Providerまたは接続先を変更したため、API Keyを再入力してください。');
    }
  }

  #publish(): SettingsSnapshot {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
    return snapshot;
  }
}
