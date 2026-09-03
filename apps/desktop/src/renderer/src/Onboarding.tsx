import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Globe2,
  LoaderCircle,
  Plus,
  Search,
  X,
} from 'lucide-react';
import {
  NATIVE_LANGUAGE_OPTIONS,
  type NativeLanguage,
  type OtherLanguageTarget,
  type ProviderConnectionDefinition,
  type ProviderKind,
  type ProviderModel,
  type SettingsSnapshot,
} from '../../shared/settings-contracts';
import { useI18n } from './i18n';
import { targetAfterNativeLanguageChange } from './main-window/language-target';
import { ProviderMark } from './main-window/ProviderModelSettings';
import { OnboardingMascot, type OnboardingMascotPhase } from './OnboardingMascot';

type OnboardingStep =
  | 'welcome'
  | 'language'
  | 'target-language'
  | 'provider'
  | 'chatgpt'
  | 'provider-setup'
  | 'complete';

interface OnboardingProviderPreset {
  readonly kind: ProviderKind;
  readonly label: string;
  readonly baseUrl?: string;
}

const COMPACT_PROVIDERS: readonly OnboardingProviderPreset[] = [
  { kind: 'openai', label: 'OpenAI' },
  { kind: 'groq', label: 'Groq' },
  { kind: 'openrouter', label: 'OpenRouter' },
  { kind: 'google', label: 'Google Gemini' },
];

const EXTRA_PROVIDERS: readonly OnboardingProviderPreset[] = [
  { kind: 'anthropic', label: 'Anthropic' },
  { kind: 'deepinfra', label: 'DeepInfra' },
  { kind: 'mistral', label: 'Mistral AI' },
  { kind: 'ollama-cloud', label: 'Ollama Cloud' },
  { kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/' },
  { kind: 'lm-studio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1/' },
  { kind: 'custom-openai-compatible', label: 'OpenAI-compatible provider' },
];

const API_KEY_KINDS = new Set<ProviderKind>([
  'openai',
  'anthropic',
  'google',
  'groq',
  'openrouter',
  'deepinfra',
  'mistral',
  'ollama-cloud',
  'custom-openai-compatible',
]);

const REQUIRED_API_KEY_KINDS = new Set<ProviderKind>([
  'openai',
  'anthropic',
  'google',
  'groq',
  'openrouter',
  'deepinfra',
  'mistral',
  'ollama-cloud',
]);

const ENDPOINT_KINDS = new Set<ProviderKind>(['ollama', 'lm-studio', 'custom-openai-compatible']);

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function guessNativeLanguage(languageTags: readonly string[]): NativeLanguage {
  const normalized = languageTags.map((tag) => tag.toLocaleLowerCase());
  for (const tag of normalized) {
    if (tag === 'zh-tw' || tag === 'zh-hk' || tag === 'zh-mo' || tag.startsWith('zh-hant')) {
      return 'Chinese (Traditional)';
    }
    if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-sg' || tag.startsWith('zh-hans')) {
      return 'Chinese (Simplified)';
    }
    const exact = NATIVE_LANGUAGE_OPTIONS.find((option) => option.tag.toLocaleLowerCase() === tag);
    if (exact) return exact.value;
  }
  for (const tag of normalized) {
    const base = tag.split('-')[0];
    const match = NATIVE_LANGUAGE_OPTIONS.find(
      (option) => option.tag.toLocaleLowerCase().split('-')[0] === base,
    );
    if (match) return match.value;
  }
  return 'English';
}

export function onboardingTargetLanguage(
  nativeLanguage: NativeLanguage,
  currentTarget: OtherLanguageTarget,
): OtherLanguageTarget {
  return nativeLanguage === 'English'
    ? targetAfterNativeLanguageChange(nativeLanguage, currentTarget)
    : 'English';
}

function OnboardingLanguageSelect({
  value,
  onChange,
  options = NATIVE_LANGUAGE_OPTIONS,
  useUiLanguageNames = false,
}: {
  readonly value: NativeLanguage;
  readonly onChange: (value: NativeLanguage) => void;
  readonly options?:
    typeof NATIVE_LANGUAGE_OPTIONS | readonly (typeof NATIVE_LANGUAGE_OPTIONS)[number][];
  readonly useUiLanguageNames?: boolean;
}): React.JSX.Element {
  const { t, formatLanguageName } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value)!;
  const selectedLabel = useUiLanguageNames ? formatLanguageName(selected.value) : selected.label;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return options;
    return options.filter((option) =>
      `${option.label} ${option.value} ${option.tag} ${formatLanguageName(option.value)}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [formatLanguageName, options, query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="onboarding-language-select">
      <button
        className="onboarding-select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Globe2 size={17} aria-hidden="true" />
        <span>{selectedLabel}</span>
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      {open && (
        <div className="onboarding-language-popover">
          <div className="onboarding-language-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={t('onboarding.languageSearch')}
              aria-label={t('onboarding.languageSearch')}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div id={listId} className="onboarding-language-options" role="listbox">
            {filtered.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <span>
                  <strong>
                    {useUiLanguageNames ? formatLanguageName(option.value) : option.label}
                  </strong>
                  <small>{useUiLanguageNames ? option.label : option.value}</small>
                </span>
                {option.value === value && <Check size={16} aria-hidden="true" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="onboarding-language-empty">{t('onboarding.languageEmpty')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DataHandlingModal({ close }: { readonly close: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [close]);
  return (
    <div
      className="onboarding-data-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="onboarding-data-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId}>{t('onboarding.dataTitle')}</h2>
          <button ref={closeRef} type="button" aria-label={t('common.close')} onClick={close}>
            <X size={18} />
          </button>
        </header>
        <p>{t('onboarding.dataProvider')}</p>
        <p>{t('onboarding.dataFumu')}</p>
        <p>{t('onboarding.dataHistory')}</p>
        <p>{t('onboarding.dataPolicy')}</p>
      </section>
    </div>
  );
}

function OnboardingFooter({
  openData,
  dataButtonRef,
  inert,
}: {
  readonly openData: () => void;
  readonly dataButtonRef: React.RefObject<HTMLButtonElement | null>;
  readonly inert: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <footer className="onboarding-footer" inert={inert}>
      <span>{t('onboarding.license')}</span>
      <span aria-hidden="true">・</span>
      <button ref={dataButtonRef} type="button" onClick={openData}>
        {t('onboarding.dataHandling')}
      </button>
    </footer>
  );
}

function ProviderRow({
  kind,
  label,
  onClick,
}: {
  readonly kind: ProviderKind;
  readonly label: string;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button className="onboarding-provider-row" type="button" onClick={onClick}>
      <ProviderMark kind={kind} />
      <span>{label}</span>
      <ChevronRight size={17} aria-hidden="true" />
    </button>
  );
}

function OnboardingBackButton({
  back,
  disabled = false,
}: {
  readonly back: () => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <button
      className="onboarding-inline-back"
      type="button"
      aria-label={t('common.back')}
      disabled={disabled}
      onClick={back}
    >
      <ChevronLeft size={18} />
    </button>
  );
}

function ToggleSwitch({ checked }: { readonly checked: boolean }): React.JSX.Element {
  return (
    <span className={`onboarding-toggle${checked ? ' is-checked' : ''}`} aria-hidden="true">
      <span />
    </span>
  );
}

const RECOMMENDED_CHATGPT_MODEL_ID = 'gpt-5.6-luna';

export function recommendedChatGptModelId(models: readonly ProviderModel[]): string | null {
  return (
    models.find((model) => model.id === RECOMMENDED_CHATGPT_MODEL_ID)?.id ?? models[0]?.id ?? null
  );
}

function chatGptDefinition(
  providerId: string,
  models: readonly ProviderModel[],
  selectedModelId: string | null,
): ProviderConnectionDefinition {
  return {
    id: providerId,
    name: 'ChatGPT',
    kind: 'chatgpt',
    models,
    enabledModelIds: selectedModelId === null ? [] : [selectedModelId],
  };
}

type ChatGptFlow = 'idle' | 'logging-in' | 'loading-models' | 'ready' | 'saving';

function ChatGptOnboarding({
  back,
  done,
}: {
  readonly back: () => void;
  readonly done: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  // OAuth資格情報をRendererへ戻さない既存実装の制約に合わせ、保存前から固定IDを使う。
  // このIDでMain側の一時資格情報とモデル保存を同じ接続として結び付ける。
  const [providerId] = useState(() => crypto.randomUUID());
  const [authenticated, setAuthenticated] = useState(false);
  const [flow, setFlow] = useState<ChatGptFlow>('idle');
  const [models, setModels] = useState<readonly ProviderModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [showOtherModels, setShowOtherModels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const otherModelsId = useId();
  const busy = flow === 'logging-in' || flow === 'loading-models' || flow === 'saving';
  const recommendedModel =
    models.find((model) => model.id === RECOMMENDED_CHATGPT_MODEL_ID) ?? models[0] ?? null;
  const otherModels = models.filter((model) => model.id !== recommendedModel?.id);

  useEffect(
    () => () => {
      operation.current += 1;
    },
    [],
  );

  const applyModels = (nextModels: readonly ProviderModel[]): void => {
    setModels(nextModels);
    setSelectedModelId(recommendedChatGptModelId(nextModels));
    setFlow('ready');
  };

  const fetchModels = async (generation: number): Promise<void> => {
    setFlow('loading-models');
    const nextModels = await window.fumu.fetchProviderModels({
      provider: chatGptDefinition(providerId, [], null),
      secret: { action: 'preserve' },
    });
    if (generation === operation.current) applyModels(nextModels);
  };

  const login = (): void => {
    const generation = ++operation.current;
    setFlow('logging-in');
    setError(null);
    void window.fumu
      .loginChatGpt(providerId)
      .then(async () => {
        if (generation !== operation.current) return;
        setAuthenticated(true);
        await fetchModels(generation);
      })
      .catch(() => {
        if (generation !== operation.current) return;
        setFlow('idle');
        setError(t('onboarding.chatgptError'));
      });
  };

  const retryModels = (): void => {
    const generation = ++operation.current;
    setError(null);
    void fetchModels(generation).catch(() => {
      if (generation !== operation.current) return;
      setFlow('idle');
      setError(t('onboarding.chatgptError'));
    });
  };

  const save = (): void => {
    if (selectedModelId === null || flow !== 'ready') return;
    const generation = ++operation.current;
    setFlow('saving');
    setError(null);
    void window.fumu
      .saveProvider({
        provider: chatGptDefinition(providerId, models, selectedModelId),
        secret: { action: 'preserve' },
      })
      .then((snapshot) =>
        window.fumu.updateUsedModels({
          models: [
            { providerId, modelId: selectedModelId },
            ...snapshot.usedModels.filter((model) => model.providerId !== providerId),
          ],
        }),
      )
      .then(() => {
        if (generation === operation.current) done();
      })
      .catch(() => {
        if (generation !== operation.current) return;
        setFlow('ready');
        setError(t('onboarding.chatgptError'));
      });
  };

  return (
    <div className="onboarding-step-copy onboarding-chatgpt-copy">
      <OnboardingBackButton back={back} disabled={busy} />
      <ProviderMark kind="chatgpt" />
      <h1>ChatGPT</h1>
      <p>{t('onboarding.chatgptDetail')}</p>

      {recommendedModel !== null ? (
        <div className="onboarding-chatgpt-models" role="radiogroup">
          <span className="onboarding-model-heading">{t('onboarding.chatgptChooseModel')}</span>
          <button
            className="onboarding-model-choice is-recommended"
            type="button"
            role="radio"
            aria-checked={selectedModelId === recommendedModel.id}
            onClick={() => setSelectedModelId(recommendedModel.id)}
          >
            <span>
              <small>{t('onboarding.modelRecommended')}</small>
              <strong>{recommendedModel.name ?? recommendedModel.id}</strong>
            </span>
            {selectedModelId === recommendedModel.id && <Check size={16} aria-hidden="true" />}
          </button>
          {otherModels.length > 0 && (
            <div
              className={`onboarding-other-models-accordion${showOtherModels ? ' is-expanded' : ''}`}
            >
              <button
                className="onboarding-other-models-toggle"
                type="button"
                aria-expanded={showOtherModels}
                aria-controls={otherModelsId}
                onClick={() => setShowOtherModels((current) => !current)}
              >
                <span>{t('onboarding.otherModels')}</span>
                <ChevronDown size={16} aria-hidden="true" />
              </button>
              <div
                id={otherModelsId}
                className={`onboarding-other-models${showOtherModels ? ' is-expanded' : ''}`}
              >
                <div>
                  {otherModels.map((model) => (
                    <button
                      className="onboarding-model-choice"
                      type="button"
                      role="radio"
                      aria-checked={selectedModelId === model.id}
                      key={model.id}
                      onClick={() => setSelectedModelId(model.id)}
                    >
                      <strong>{model.name ?? model.id}</strong>
                      {selectedModelId === model.id && <Check size={16} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="onboarding-chatgpt-status" aria-live="polite">
          {(flow === 'logging-in' || flow === 'loading-models') && (
            <LoaderCircle className="is-spinning" size={18} aria-hidden="true" />
          )}
          <span>
            {flow === 'logging-in'
              ? t('onboarding.chatgptLoggingIn')
              : flow === 'loading-models'
                ? t('onboarding.chatgptFetchingModels')
                : authenticated
                  ? t('provider.loggedIn')
                  : t('onboarding.chatgptLoginPrompt')}
          </span>
        </div>
      )}

      {error && (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      )}

      {models.length > 0 ? (
        <button
          className="onboarding-primary is-visible"
          type="button"
          disabled={selectedModelId === null || flow === 'saving'}
          onClick={save}
        >
          {flow === 'saving' ? t('common.saving') : t('onboarding.chatgptContinue')}
        </button>
      ) : (
        <button
          className="onboarding-primary is-visible"
          type="button"
          disabled={busy}
          onClick={authenticated ? retryModels : login}
        >
          {authenticated ? t('onboarding.chatgptFetchAgain') : t('provider.login')}
        </button>
      )}
    </div>
  );
}

function providerDefinition(
  preset: OnboardingProviderPreset,
  providerId: string,
  models: readonly ProviderModel[],
  selectedModelId: string | null,
  baseUrl: string,
): ProviderConnectionDefinition {
  const common = {
    id: providerId,
    name: preset.label,
    models,
    enabledModelIds: selectedModelId === null ? [] : [selectedModelId],
  };
  if (preset.kind === 'ollama' || preset.kind === 'lm-studio') {
    return { ...common, kind: preset.kind, baseUrl: baseUrl.trim() };
  }
  if (preset.kind === 'custom-openai-compatible') {
    return {
      ...common,
      kind: preset.kind,
      baseUrl: baseUrl.trim(),
      supportsJsonObjectResponse: true,
      includeUsage: false,
    };
  }
  return { ...common, kind: preset.kind };
}

type ProviderSetupFlow = 'idle' | 'fetching' | 'ready' | 'saving';

function ProviderSetupOnboarding({
  preset,
  back,
  done,
}: {
  readonly preset: OnboardingProviderPreset;
  readonly back: () => void;
  readonly done: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [providerId] = useState(() => crypto.randomUUID());
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<readonly ProviderModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [manualModelId, setManualModelId] = useState('');
  const [query, setQuery] = useState('');
  const [flow, setFlow] = useState<ProviderSetupFlow>('idle');
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const autoFetchSignature = useRef<string | null>(null);
  const needsApiKey = API_KEY_KINDS.has(preset.kind);
  const needsEndpoint = ENDPOINT_KINDS.has(preset.kind);
  const busy = flow === 'fetching' || flow === 'saving';
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return models;
    return models.filter((model) =>
      `${model.name ?? ''} ${model.id}`.toLocaleLowerCase().includes(normalized),
    );
  }, [models, query]);

  useEffect(
    () => () => {
      operation.current += 1;
    },
    [],
  );

  const secret = () =>
    apiKey.trim().length > 0
      ? ({ action: 'replace', apiKey: apiKey.trim() } as const)
      : ({ action: 'clear' } as const);

  const validateConnection = (): boolean => {
    if (REQUIRED_API_KEY_KINDS.has(preset.kind) && apiKey.trim().length === 0) {
      setError(t('provider.apiKeyRequired'));
      return false;
    }
    if (needsEndpoint && baseUrl.trim().length === 0) {
      setError(t('provider.endpointRequired'));
      return false;
    }
    return true;
  };

  const fetchModels = (): void => {
    if (!validateConnection()) return;
    const generation = ++operation.current;
    setFlow('fetching');
    setError(null);
    void window.fumu
      .fetchProviderModels({
        provider: providerDefinition(preset, providerId, models, selectedModelId, baseUrl),
        secret: secret(),
      })
      .then((fetchedModels) => {
        if (generation !== operation.current) return;
        const manualModels = models.filter(
          (model) =>
            model.source === 'manual' && !fetchedModels.some((fetched) => fetched.id === model.id),
        );
        const nextModels = [...fetchedModels, ...manualModels];
        setModels(nextModels);
        setSelectedModelId((current) =>
          current !== null && nextModels.some((model) => model.id === current)
            ? current
            : (nextModels[0]?.id ?? null),
        );
        setFlow('ready');
      })
      .catch(() => {
        if (generation !== operation.current) return;
        setFlow('idle');
        setError(t('onboarding.providerError'));
      });
  };

  useEffect(() => {
    const normalizedKey = apiKey.trim();
    const normalizedEndpoint = baseUrl.trim();
    if (!needsApiKey || normalizedKey.length < 8) return;
    if (needsEndpoint && normalizedEndpoint.length === 0) return;
    const signature = `${preset.kind}\u0000${normalizedEndpoint}\u0000${normalizedKey}`;
    if (autoFetchSignature.current === signature) return;
    // 入力途中の各キー操作で外部APIを呼ばないよう、入力が止まってから一度だけ取得する。
    const timer = window.setTimeout(() => {
      autoFetchSignature.current = signature;
      fetchModels();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [apiKey, baseUrl, needsApiKey, needsEndpoint, preset.kind]);

  const addManualModel = (): void => {
    const id = manualModelId.trim();
    if (id.length === 0) return;
    setModels((current) =>
      current.some((model) => model.id === id)
        ? current
        : [...current, { id, metadata: {}, source: 'manual' }],
    );
    setSelectedModelId(id);
    setManualModelId('');
    setFlow('ready');
    setError(null);
  };

  const save = (): void => {
    if (selectedModelId === null || !validateConnection()) return;
    const generation = ++operation.current;
    setFlow('saving');
    setError(null);
    void window.fumu
      .saveProvider({
        provider: providerDefinition(preset, providerId, models, selectedModelId, baseUrl),
        secret: secret(),
      })
      .then((snapshot) =>
        window.fumu.updateUsedModels({
          models: [
            { providerId, modelId: selectedModelId },
            ...snapshot.usedModels.filter((model) => model.providerId !== providerId),
          ],
        }),
      )
      .then(() => {
        if (generation === operation.current) done();
      })
      .catch(() => {
        if (generation !== operation.current) return;
        setFlow('ready');
        setError(t('onboarding.providerError'));
      });
  };

  return (
    <div className="onboarding-step-copy onboarding-provider-setup-copy">
      <OnboardingBackButton back={back} disabled={busy} />
      <ProviderMark kind={preset.kind} />
      <h1>{preset.label}</h1>
      <p>{t('onboarding.providerSetupDetail')}</p>

      <div className="onboarding-provider-fields">
        {needsEndpoint && (
          <label>
            <span>{t('provider.endpoint')}</span>
            <input
              type="url"
              value={baseUrl}
              placeholder="https://…/v1/"
              disabled={busy}
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </label>
        )}
        {needsApiKey && (
          <label>
            <span>{t('provider.apiKey')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              disabled={busy}
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
          </label>
        )}
      </div>

      <button
        className="onboarding-fetch-models"
        type="button"
        disabled={busy}
        onClick={fetchModels}
      >
        {flow === 'fetching' && <LoaderCircle className="is-spinning" size={16} />}
        {flow === 'fetching' ? t('provider.fetching') : t('provider.fetchModels')}
      </button>

      {models.length > 0 && (
        <div className="onboarding-provider-model-picker">
          <div className="onboarding-model-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              aria-label={t('provider.searchModels')}
              placeholder={t('provider.searchModels')}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div className="onboarding-provider-model-list">
            {filteredModels.map((model) => {
              const checked = selectedModelId === model.id;
              return (
                <button
                  type="button"
                  role="switch"
                  aria-checked={checked}
                  key={model.id}
                  onClick={() => setSelectedModelId(checked ? null : model.id)}
                >
                  <span>
                    <strong>{model.name ?? model.id}</strong>
                    {model.name && <small>{model.id}</small>}
                  </span>
                  <ToggleSwitch checked={checked} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="onboarding-manual-model">
        <input
          value={manualModelId}
          maxLength={500}
          placeholder="Model ID"
          aria-label="Model ID"
          disabled={busy}
          onChange={(event) => setManualModelId(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            addManualModel();
          }}
        />
        <button
          type="button"
          disabled={busy || manualModelId.trim().length === 0}
          onClick={addManualModel}
        >
          <Plus size={15} aria-hidden="true" />
          {t('common.add')}
        </button>
      </div>

      {error && (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      )}

      <button
        className="onboarding-primary is-visible"
        type="button"
        disabled={selectedModelId === null || busy}
        onClick={save}
      >
        {flow === 'saving' ? t('common.saving') : t('onboarding.useModel')}
      </button>
    </div>
  );
}

export function Onboarding({
  settings,
  logoTargetRef,
  onRevealChange,
}: {
  readonly settings: SettingsSnapshot;
  readonly logoTargetRef: React.RefObject<HTMLElement | null>;
  readonly onRevealChange: (revealing: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [wordStage, setWordStage] = useState(0);
  const [welcomeReady, setWelcomeReady] = useState(false);
  const [completeTitleReady, setCompleteTitleReady] = useState(false);
  const [completeButtonReady, setCompleteButtonReady] = useState(false);
  const [mascotPhase, setMascotPhase] = useState<OnboardingMascotPhase>('entering');
  const [selectedLanguage, setSelectedLanguage] = useState<NativeLanguage>(
    () => settings.nativeLanguage ?? guessNativeLanguage(navigator.languages),
  );
  const [selectedTargetLanguage, setSelectedTargetLanguage] = useState<OtherLanguageTarget>(() =>
    onboardingTargetLanguage('English', settings.otherLanguageTarget),
  );
  const [providersExpanded, setProvidersExpanded] = useState(false);
  const [providerPreset, setProviderPreset] = useState<OnboardingProviderPreset | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [departing, setDeparting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mascotFrameRef = useRef<HTMLDivElement>(null);
  const dataButtonRef = useRef<HTMLButtonElement>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const departureTimerRef = useRef<number | null>(null);
  const languageSaveGeneration = useRef(0);
  const targetLanguageOptions = useMemo(
    () => NATIVE_LANGUAGE_OPTIONS.filter((option) => option.value !== 'English'),
    [],
  );

  const closeData = (): void => {
    setDataOpen(false);
    window.requestAnimationFrame(() => dataButtonRef.current?.focus());
  };

  useEffect(() => {
    if (step !== 'welcome') return;
    if (prefersReducedMotion()) {
      setWordStage(4);
      setWelcomeReady(true);
      setMascotPhase('idle');
      return;
    }
    const timers = [
      window.setTimeout(() => setMascotPhase('idle'), 520),
      window.setTimeout(() => setWordStage(1), 560),
      window.setTimeout(() => setWordStage(2), 720),
      window.setTimeout(() => setWordStage(3), 880),
      window.setTimeout(() => setWordStage(4), 1040),
      // ロゴの最終モーションを一度見せ切ってから、説明と操作を静かに出す。
      window.setTimeout(() => setWelcomeReady(true), 1680),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, [step]);

  // complete到着: マスコットを上の画面外から落下させ、着地の反動まで見せ切ってから十分に間を置き、
  // まずタイトルを表示する。タイトルを読める一拍を置いてから、主操作のボタンを表示する。
  useEffect(() => {
    if (step !== 'complete') return;
    if (prefersReducedMotion()) {
      setMascotPhase('complete');
      setCompleteTitleReady(true);
      setCompleteButtonReady(true);
      return;
    }
    setMascotPhase('landing');
    setCompleteTitleReady(false);
    setCompleteButtonReady(false);
    const titleRevealTimer = window.setTimeout(() => setCompleteTitleReady(true), 1_300);
    const buttonRevealTimer = window.setTimeout(() => setCompleteButtonReady(true), 1_900);
    return () => {
      window.clearTimeout(titleRevealTimer);
      window.clearTimeout(buttonRevealTimer);
    };
  }, [step]);

  useEffect(
    () => () => {
      if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current);
      if (departureTimerRef.current !== null) window.clearTimeout(departureTimerRef.current);
      languageSaveGeneration.current += 1;
    },
    [],
  );

  const transitionTo = (nextStep: OnboardingStep): void => {
    if (transitioning || nextStep === step) return;
    if (prefersReducedMotion()) {
      setStep(nextStep);
      return;
    }
    setTransitioning(true);
    transitionTimerRef.current = window.setTimeout(() => {
      setStep(nextStep);
      setTransitioning(false);
      transitionTimerRef.current = null;
    }, 170);
  };

  // welcome開始: まず既存どおり onboardingCompleted:false を保存し、その成功後にマスコットを射出して
  // 同じwelcome画面を見せ続けてから言語画面へ切り替える。
  // コピーは射出開始と同時に300msでフェードし、マスコットの沈み込みだけが一瞬残る。
  // 940ms: フレームの射出アニメーションが画面外滞在へ入るタイミングで言語画面へ。
  const beginWelcomeDeparture = (): void => {
    setSaving(true);
    setError(null);
    void window.fumu
      .updateGeneralSettings({ onboardingCompleted: false })
      .then(() => {
        if (prefersReducedMotion()) {
          setStep('language');
          return;
        }
        setDeparting(true);
        setMascotPhase('departure');
        transitionTimerRef.current = window.setTimeout(() => {
          setWelcomeReady(false);
          transitionTimerRef.current = null;
        }, 300);
        departureTimerRef.current = window.setTimeout(() => {
          setDeparting(false);
          setMascotPhase('idle');
          setStep('language');
        }, 940);
      })
      .catch(() => setError(t('onboarding.saveError')))
      .finally(() => setSaving(false));
  };

  const persistLanguage = (language: NativeLanguage, continueAfterSave: boolean): void => {
    const generation = ++languageSaveGeneration.current;
    setSelectedLanguage(language);
    // 英語以外では対訳先を英語に揃える。英語だけは同一言語への翻訳を避けるため、
    // 次の画面で利用者が明示的に選べる現在値を保持する。
    const targetLanguage = onboardingTargetLanguage(language, selectedTargetLanguage);
    setSelectedTargetLanguage(targetLanguage);
    setSaving(true);
    setError(null);
    void window.fumu
      .updateGeneralSettings({
        nativeLanguage: language,
        otherLanguageTarget: targetLanguage,
      })
      .then(() => {
        if (generation !== languageSaveGeneration.current) return;
        if (continueAfterSave) {
          transitionTo(
            language === 'English'
              ? 'target-language'
              : settings.usedModels.length > 0
                ? 'complete'
                : 'provider',
          );
        }
      })
      .catch(() => {
        if (generation === languageSaveGeneration.current) setError(t('onboarding.saveError'));
      })
      .finally(() => {
        if (generation === languageSaveGeneration.current) setSaving(false);
      });
  };

  const persistTargetLanguage = (
    targetLanguage: OtherLanguageTarget,
    continueAfterSave: boolean,
  ): void => {
    const generation = ++languageSaveGeneration.current;
    const normalizedTarget = targetAfterNativeLanguageChange('English', targetLanguage);
    setSelectedTargetLanguage(normalizedTarget);
    setSaving(true);
    setError(null);
    void window.fumu
      .updateGeneralSettings({ otherLanguageTarget: normalizedTarget })
      .then(() => {
        if (generation !== languageSaveGeneration.current) return;
        if (continueAfterSave) {
          transitionTo(settings.usedModels.length > 0 ? 'complete' : 'provider');
        }
      })
      .catch(() => {
        if (generation === languageSaveGeneration.current) setError(t('onboarding.saveError'));
      })
      .finally(() => {
        if (generation === languageSaveGeneration.current) setSaving(false);
      });
  };

  const launchProvider = (preset: OnboardingProviderPreset): void => {
    setProviderPreset(preset);
    transitionTo('provider-setup');
  };

  const finish = (): void => {
    const frame = mascotFrameRef.current;
    const target = logoTargetRef.current;
    if (!frame || !target || saving) return;
    const sourceBounds = frame.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const sidebar = target.closest<HTMLElement>('.nani-sidebar');
    const sidebarTransform = sidebar ? getComputedStyle(sidebar).transform : 'none';
    const sidebarMatrix =
      sidebarTransform === 'none'
        ? new DOMMatrixReadOnly()
        : new DOMMatrixReadOnly(sidebarTransform);
    // メインUIは下から登場するため、計測時のsidebarには一時的なtranslateが掛かっている。
    // その移動量を除いた最終座標へ飛ばし、アニメーション中だけ着地点がずれないようにする。
    const targetLeft = targetBounds.left - sidebarMatrix.e;
    const targetTop = targetBounds.top - sidebarMatrix.f;
    const handoffX =
      targetLeft + targetBounds.width / 2 - (sourceBounds.left + sourceBounds.width / 2);
    const handoffY =
      targetTop + targetBounds.height / 2 - (sourceBounds.top + sourceBounds.height / 2);
    const handoffScale = targetBounds.width / sourceBounds.width;
    // class付与と目標値の変更を同じ描画フレームで行うと、ブラウザが開始値を計測できず
    // キャラクターが最終位置へ瞬間移動する。先に0移動・等倍のhandoff状態を描画し、
    // 次のフレームで目標値を入れて、既存のtransitionを確実に開始させる。
    frame.style.setProperty('--onboarding-handoff-x', '0px');
    frame.style.setProperty('--onboarding-handoff-y', '0px');
    frame.style.setProperty('--onboarding-handoff-scale', '1');
    setError(null);
    setSaving(true);
    setLeaving(true);
    setMascotPhase('handoff');
    onRevealChange(true);
    window.requestAnimationFrame(() => {
      frame.style.setProperty('--onboarding-handoff-x', `${handoffX}px`);
      frame.style.setProperty('--onboarding-handoff-y', `${handoffY}px`);
      frame.style.setProperty('--onboarding-handoff-scale', String(handoffScale));
    });
    window.setTimeout(
      () => {
        void window.fumu.updateGeneralSettings({ onboardingCompleted: true }).catch(() => {
          setSaving(false);
          setLeaving(false);
          setMascotPhase('complete');
          onRevealChange(false);
          setError(t('onboarding.saveError'));
        });
      },
      prefersReducedMotion() ? 120 : 760,
    );
  };

  const welcomeWord = ['', 'F', 'Fu', 'Fum', 'Fumu!'][wordStage];

  return (
    <section className={`onboarding-shell${leaving ? ' is-leaving' : ''}`} aria-label="Fumu!">
      <div className="onboarding-backdrop" aria-hidden="true" />
      <div
        className={`onboarding-panel onboarding-panel-${step}${transitioning ? ' is-transitioning' : ''}${departing ? ' is-departing' : ''}`}
        inert={dataOpen}
      >
        {(step === 'welcome' || step === 'complete') && (
          <div
            ref={mascotFrameRef}
            className={`onboarding-mascot-frame${leaving ? ' is-handoff' : ''}${departing ? ' is-departure' : ''}${step === 'complete' && mascotPhase === 'landing' ? ' is-landing' : ''}`}
          >
            <OnboardingMascot phase={mascotPhase} />
          </div>
        )}

        {step === 'welcome' && (
          <div className="onboarding-welcome-copy">
            <div className="onboarding-wordmark" aria-label="Fumu!">
              <span
                key={wordStage}
                className={wordStage === 4 ? 'is-final' : undefined}
                aria-hidden="true"
              >
                {welcomeWord}
              </span>
            </div>
            <h1 className={welcomeReady && !departing ? 'is-visible' : undefined}>
              {t('onboarding.welcome')}
            </h1>
            <button
              className={`onboarding-primary${welcomeReady && !departing ? ' is-visible' : ''}`}
              type="button"
              disabled={saving || departing}
              onClick={beginWelcomeDeparture}
            >
              {t('onboarding.start')}
            </button>
          </div>
        )}

        {step === 'language' && (
          <div className="onboarding-step-copy">
            <h1>{t('onboarding.languageTitle')}</h1>
            <p>{t('onboarding.languageDetail')}</p>
            <OnboardingLanguageSelect
              value={selectedLanguage}
              onChange={(language) => persistLanguage(language, false)}
            />
            <button
              className="onboarding-primary is-visible"
              type="button"
              disabled={saving}
              onClick={() => persistLanguage(selectedLanguage, true)}
            >
              {t('onboarding.next')}
            </button>
          </div>
        )}

        {step === 'target-language' && (
          <div className="onboarding-step-copy">
            <OnboardingBackButton back={() => transitionTo('language')} disabled={saving} />
            <h1>{t('onboarding.targetLanguageTitle')}</h1>
            <p>{t('onboarding.targetLanguageDetail')}</p>
            <OnboardingLanguageSelect
              value={selectedTargetLanguage}
              options={targetLanguageOptions}
              useUiLanguageNames
              onChange={(language) => persistTargetLanguage(language, false)}
            />
            <button
              className="onboarding-primary is-visible"
              type="button"
              disabled={saving}
              onClick={() => persistTargetLanguage(selectedTargetLanguage, true)}
            >
              {t('onboarding.next')}
            </button>
          </div>
        )}

        {step === 'provider' && (
          <div className="onboarding-step-copy onboarding-provider-copy">
            <OnboardingBackButton
              back={() =>
                transitionTo(selectedLanguage === 'English' ? 'target-language' : 'language')
              }
            />
            <h1>{t('onboarding.providerTitle')}</h1>
            <div className="onboarding-provider-group">
              <span>{t('onboarding.recommended')}</span>
              <ProviderRow kind="chatgpt" label="ChatGPT" onClick={() => transitionTo('chatgpt')} />
            </div>
            <button
              className="onboarding-provider-expand"
              type="button"
              aria-expanded={providersExpanded}
              onClick={() => setProvidersExpanded((current) => !current)}
            >
              {t('onboarding.addProviders')}
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            <div className={`onboarding-provider-more${providersExpanded ? ' is-expanded' : ''}`}>
              <div>
                <span>{t('onboarding.otherProviders')}</span>
                <div className="onboarding-provider-list">
                  {[...COMPACT_PROVIDERS, ...EXTRA_PROVIDERS].map((provider) => {
                    const localizedProvider =
                      provider.kind === 'custom-openai-compatible'
                        ? { ...provider, label: t('provider.customLabel') }
                        : provider;
                    return (
                      <ProviderRow
                        key={provider.kind}
                        kind={provider.kind}
                        label={localizedProvider.label}
                        onClick={() => launchProvider(localizedProvider)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 'chatgpt' && (
          <ChatGptOnboarding
            back={() => transitionTo('provider')}
            done={() => transitionTo('complete')}
          />
        )}

        {step === 'provider-setup' && providerPreset !== null && (
          <ProviderSetupOnboarding
            key={providerPreset.kind}
            preset={providerPreset}
            back={() => transitionTo('provider')}
            done={() => transitionTo('complete')}
          />
        )}

        {step === 'complete' && (
          <div
            className={`onboarding-complete-copy${completeTitleReady ? ' is-visible' : ' is-waiting'}`}
          >
            <h1>{t('onboarding.complete')}</h1>
            <button
              className={`onboarding-primary${completeButtonReady ? ' is-visible' : ''}`}
              type="button"
              disabled={!completeButtonReady || saving}
              onClick={finish}
            >
              {t('onboarding.start')}
            </button>
          </div>
        )}

        {error && (
          <p className="onboarding-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <OnboardingFooter
        openData={() => setDataOpen(true)}
        dataButtonRef={dataButtonRef}
        inert={dataOpen}
      />
      {dataOpen && <DataHandlingModal close={closeData} />}
    </section>
  );
}
