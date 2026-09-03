import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CodeXml,
  GripVertical,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import anthropicLogo from '../assets/provider-logos/anthropic.png';
import deepInfraLogo from '../assets/provider-logos/deepinfra.png';
import googleGeminiLogo from '../assets/provider-logos/google-gemini.png';
import groqLogo from '../assets/provider-logos/groq.png';
import lmStudioLogo from '../assets/provider-logos/lm-studio.png';
import mistralLogo from '../assets/provider-logos/mistral.png';
import ollamaLogo from '../assets/provider-logos/ollama.png';
import codexLogo from '../assets/provider-logos/codex-color.svg';
import openAiLogo from '../assets/provider-logos/openai.png';
import openRouterLogo from '../assets/provider-logos/openrouter.png';
import type {
  ProviderConnection,
  ProviderConnectionDefinition,
  ProviderKind,
  ProviderModel,
  ProviderSecretUpdate,
  SettingsSnapshot,
  UsedModelReference,
} from '../../../shared/settings-contracts';
import { useI18n, type MessageKey } from '../i18n';

type PresetGroup = 'recommended' | 'other' | 'local' | 'custom';

interface Preset {
  readonly kind: ProviderKind;
  readonly label: string;
  readonly group: PresetGroup;
  readonly labelKey?: MessageKey;
  readonly hintKey?: MessageKey;
  readonly baseUrl?: string;
  readonly logoSrc?: string;
}

const PRESETS: readonly Preset[] = [
  { kind: 'chatgpt', label: 'ChatGPT', group: 'recommended', logoSrc: codexLogo },
  { kind: 'openai', label: 'OpenAI', group: 'recommended', logoSrc: openAiLogo },
  { kind: 'anthropic', label: 'Anthropic', group: 'other', logoSrc: anthropicLogo },
  { kind: 'google', label: 'Google Gemini', group: 'recommended', logoSrc: googleGeminiLogo },
  { kind: 'groq', label: 'Groq', group: 'recommended', logoSrc: groqLogo },
  { kind: 'openrouter', label: 'OpenRouter', group: 'recommended', logoSrc: openRouterLogo },
  { kind: 'deepinfra', label: 'DeepInfra', group: 'other', logoSrc: deepInfraLogo },
  { kind: 'mistral', label: 'Mistral AI', group: 'other', logoSrc: mistralLogo },
  { kind: 'ollama-cloud', label: 'Ollama Cloud', group: 'other', logoSrc: ollamaLogo },
  {
    kind: 'ollama',
    label: 'Ollama',
    group: 'local',
    hintKey: 'provider.localHint',
    baseUrl: 'http://localhost:11434/',
    logoSrc: ollamaLogo,
  },
  {
    kind: 'lm-studio',
    label: 'LM Studio',
    group: 'local',
    hintKey: 'provider.localHint',
    baseUrl: 'http://localhost:1234/v1/',
    logoSrc: lmStudioLogo,
  },
  {
    kind: 'custom-openai-compatible',
    label: 'OpenAI-compatible provider',
    labelKey: 'provider.customLabel',
    group: 'custom',
    hintKey: 'provider.customHint',
  },
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

function presetOf(kind: ProviderKind): Preset {
  return PRESETS.find((preset) => preset.kind === kind)!;
}

interface Draft {
  readonly id: string | null;
  readonly isNew: boolean;
  readonly kind: ProviderKind;
  readonly name: string;
  readonly baseUrl: string;
  readonly supportsJsonObjectResponse: boolean;
  readonly includeUsage: boolean;
  readonly apiKey: string;
  readonly authenticated: boolean;
  readonly models: readonly ProviderModel[];
  readonly enabledModelIds: readonly string[];
}

function draftForPreset(preset: Preset, displayName: string): Draft {
  return {
    // OAuth tokenをRendererへ渡さずMain内の一時領域と結び付けるため、
    // ChatGPTだけは保存前から推測困難なProvider IDを持たせる。
    id: preset.kind === 'chatgpt' ? crypto.randomUUID() : null,
    isNew: true,
    kind: preset.kind,
    name: displayName,
    baseUrl: preset.baseUrl ?? '',
    supportsJsonObjectResponse: true,
    includeUsage: false,
    apiKey: '',
    authenticated: false,
    models: [],
    enabledModelIds: [],
  };
}

function draftForProvider(provider: ProviderConnection): Draft {
  return {
    id: provider.id,
    isNew: false,
    kind: provider.kind,
    name: provider.name,
    baseUrl: 'baseUrl' in provider ? provider.baseUrl : '',
    supportsJsonObjectResponse:
      provider.kind === 'custom-openai-compatible' ? provider.supportsJsonObjectResponse : true,
    includeUsage: provider.kind === 'custom-openai-compatible' ? provider.includeUsage : false,
    apiKey: '',
    authenticated: provider.hasApiKey,
    models: provider.models,
    enabledModelIds: provider.enabledModelIds,
  };
}

function definition(draft: Draft): ProviderConnectionDefinition {
  const common = {
    id: draft.id,
    name: draft.name.trim(),
    models: draft.models,
    enabledModelIds: draft.enabledModelIds,
  };
  if (draft.kind === 'ollama' || draft.kind === 'lm-studio') {
    return { ...common, kind: draft.kind, baseUrl: draft.baseUrl.trim() };
  }
  if (draft.kind === 'custom-openai-compatible') {
    return {
      ...common,
      kind: draft.kind,
      baseUrl: draft.baseUrl.trim(),
      supportsJsonObjectResponse: draft.supportsJsonObjectResponse,
      includeUsage: draft.includeUsage,
    };
  }
  return { ...common, kind: draft.kind };
}

function secretFor(draft: Draft, existing: ProviderConnection | null): ProviderSecretUpdate {
  if (draft.kind === 'chatgpt') return { action: 'preserve' };
  if (!API_KEY_KINDS.has(draft.kind)) return { action: 'clear' };
  if (draft.apiKey.trim()) return { action: 'replace', apiKey: draft.apiKey.trim() };
  return existing?.hasApiKey ? { action: 'preserve' } : { action: 'clear' };
}

export function ProviderMark({ kind }: { readonly kind: ProviderKind }): React.JSX.Element {
  const preset = presetOf(kind);
  return (
    <span className={`provider-mark provider-mark-${kind}`} aria-hidden="true">
      {preset.logoSrc ? <img src={preset.logoSrc} alt="" /> : <CodeXml size={17} strokeWidth={2} />}
    </span>
  );
}

function PresetPicker({
  settings,
  select,
}: {
  readonly settings: SettingsSnapshot;
  readonly select: (preset: Preset) => void;
}) {
  const { t } = useI18n();
  const groups: readonly { readonly value: PresetGroup; readonly label: string }[] = [
    { value: 'recommended', label: t('provider.groupRecommended') },
    { value: 'other', label: t('provider.groupOther') },
    { value: 'local', label: t('provider.groupLocal') },
    { value: 'custom', label: t('provider.groupCustom') },
  ];
  return (
    <div className="provider-preset-groups">
      {groups.map((group) => (
        <section className="settings-section nani-settings-card" key={group.value}>
          <div className="settings-heading-row">
            <h2>{group.label}</h2>
          </div>
          <div className="style-list provider-preset-card">
            {PRESETS.filter((preset) => preset.group === group.value).map((preset) => {
              const count = settings.providers.filter(
                (provider) => provider.kind === preset.kind,
              ).length;
              return (
                <button
                  className="style-row provider-choice-row"
                  type="button"
                  key={preset.kind}
                  onClick={() => select(preset)}
                >
                  <ProviderMark kind={preset.kind} />
                  <span className="provider-choice-copy">
                    <strong>{preset.labelKey ? t(preset.labelKey) : preset.label}</strong>
                    {preset.hintKey && <small>{t(preset.hintKey)}</small>}
                    {count > 0 && <small>{t('common.itemCount', { count })}</small>}
                  </span>
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function ProviderEditor({
  draft: initial,
  settings,
  done,
  deleted,
}: {
  readonly draft: Draft;
  readonly settings: SettingsSnapshot;
  readonly done: (snapshot: SettingsSnapshot, draft: Draft) => void | Promise<void>;
  readonly deleted: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const [manualId, setManualId] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelSearchId = useId();
  const fetchGeneration = useRef(0);
  const loginGeneration = useRef(0);
  const existing =
    draft.id === null
      ? null
      : (settings.providers.find((provider) => provider.id === draft.id) ?? null);
  const secret = secretFor(draft, existing);
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    if (!query) return draft.models;
    return draft.models.filter((model) =>
      [model.name, model.id, model.description, model.ownedBy].some((value) =>
        value?.toLocaleLowerCase().includes(query),
      ),
    );
  }, [draft.models, modelQuery]);
  const updateConnection = (next: Draft): void => {
    // 接続先やKeyを編集中に変更した場合、変更前の要求結果を現在のProviderへ
    // 結び付けない。通信自体は完了してもgeneration不一致で破棄される。
    fetchGeneration.current += 1;
    setLoading(false);
    setDraft(next);
  };

  const fetchModels = (): void => {
    if (REQUIRED_API_KEY_KINDS.has(draft.kind) && secret.action === 'clear') {
      setError(t('provider.apiKeyRequired'));
      return;
    }
    setLoading(true);
    setError(null);
    const generation = ++fetchGeneration.current;
    void window.fumu
      .fetchProviderModels({ provider: definition(draft), secret })
      .then((models) => {
        if (generation !== fetchGeneration.current) return;
        setDraft((current) => {
          const enabled = new Set(current.enabledModelIds);
          const manual = current.models.filter(
            (model) => model.source === 'manual' && !models.some((item) => item.id === model.id),
          );
          return {
            ...current,
            models: [...models, ...manual],
            enabledModelIds: [...enabled].filter(
              (id) =>
                models.some((model) => model.id === id) || manual.some((model) => model.id === id),
            ),
          };
        });
      })
      .catch(() => {
        if (generation === fetchGeneration.current) setError(t('common.genericError'));
      })
      .finally(() => {
        if (generation === fetchGeneration.current) setLoading(false);
      });
  };

  useEffect(
    () => () => {
      fetchGeneration.current += 1;
      loginGeneration.current += 1;
    },
    [],
  );

  const addManual = (): void => {
    const id = manualId.trim();
    if (!id) return;
    if (draft.models.some((model) => model.id === id)) {
      setDraft({ ...draft, enabledModelIds: [...new Set([...draft.enabledModelIds, id])] });
    } else {
      setDraft({
        ...draft,
        models: [...draft.models, { id, metadata: {}, source: 'manual' }],
        enabledModelIds: [...draft.enabledModelIds, id],
      });
    }
    setManualId('');
  };

  const save = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!draft.name.trim()) {
      setError(t('provider.nameRequired'));
      return;
    }
    if (draft.kind === 'chatgpt' && !draft.authenticated) {
      setError(t('provider.loginRequired'));
      return;
    }
    if (
      (draft.kind === 'ollama' ||
        draft.kind === 'lm-studio' ||
        draft.kind === 'custom-openai-compatible') &&
      !draft.baseUrl.trim()
    ) {
      setError(t('provider.endpointRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    void window.fumu
      .saveProvider({ provider: definition(draft), secret })
      .then((snapshot) => done(snapshot, draft))
      .catch(() => setError(t('common.genericError')))
      .finally(() => setSaving(false));
  };

  return (
    <form className="provider-flow-editor settings-section nani-settings-card" onSubmit={save}>
      <label>
        <span>{t('provider.name')}</span>
        <input
          value={draft.name}
          maxLength={80}
          onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
        />
      </label>
      {(draft.kind === 'ollama' ||
        draft.kind === 'lm-studio' ||
        draft.kind === 'custom-openai-compatible') && (
        <label>
          <span>{t('provider.endpoint')}</span>
          <input
            type="url"
            value={draft.baseUrl}
            placeholder="https://…/v1/"
            onChange={(event) => updateConnection({ ...draft, baseUrl: event.currentTarget.value })}
          />
        </label>
      )}
      {API_KEY_KINDS.has(draft.kind) && (
        <label>
          <span>
            {t('provider.apiKey')}
            {existing?.hasApiKey ? t('provider.apiKeyUnchanged') : ''}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={draft.apiKey}
            onChange={(event) => updateConnection({ ...draft, apiKey: event.currentTarget.value })}
          />
        </label>
      )}
      {draft.kind === 'chatgpt' && (
        <div className="provider-login-row">
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              if (draft.id === null) return;
              const generation = ++loginGeneration.current;
              setLoggingIn(true);
              setError(null);
              void window.fumu
                .loginChatGpt(draft.id)
                .then(() => {
                  if (generation === loginGeneration.current) {
                    setDraft((current) => ({ ...current, authenticated: true }));
                  }
                })
                .catch(() => {
                  if (generation === loginGeneration.current) setError(t('common.genericError'));
                })
                .finally(() => {
                  if (generation === loginGeneration.current) setLoggingIn(false);
                });
            }}
          >
            {loggingIn ? t('provider.reopenLogin') : t('provider.login')}
          </button>
          {draft.authenticated && <span>{t('provider.loggedIn')}</span>}
        </div>
      )}
      {draft.kind === 'custom-openai-compatible' && (
        <div className="provider-capabilities">
          <label>
            <input
              type="checkbox"
              checked={draft.supportsJsonObjectResponse}
              onChange={(event) =>
                setDraft({ ...draft, supportsJsonObjectResponse: event.currentTarget.checked })
              }
            />{' '}
            {t('provider.jsonMode')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.includeUsage}
              onChange={(event) =>
                setDraft({ ...draft, includeUsage: event.currentTarget.checked })
              }
            />{' '}
            {t('provider.usage')}
          </label>
        </div>
      )}
      <div className="provider-model-heading">
        <div>
          <h2>{t('provider.models')}</h2>
          <p>{t('provider.modelsDetail')}</p>
        </div>
        <button className="secondary-button" type="button" disabled={loading} onClick={fetchModels}>
          <RefreshCw size={15} />
          {loading ? t('provider.fetching') : t('provider.fetchModels')}
        </button>
      </div>
      {draft.models.length > 0 && (
        <div className="search-field provider-model-search">
          <Search size={16} aria-hidden="true" />
          <label className="sr-only" htmlFor={modelSearchId}>
            {t('provider.searchModels')}
          </label>
          <input
            id={modelSearchId}
            type="search"
            value={modelQuery}
            maxLength={500}
            placeholder={t('provider.searchModels')}
            onChange={(event) => setModelQuery(event.currentTarget.value)}
          />
        </div>
      )}
      <div className="provider-model-options">
        {filteredModels.map((model) => (
          <label className="quick-settings-toggle provider-model-option" key={model.id}>
            <span className="provider-model-copy">
              <strong>{model.name ?? model.id}</strong>
              {model.name && <small>{model.id}</small>}
              {model.description && <small>{model.description}</small>}
              {(model.ownedBy || model.contextLength || model.createdAt) && (
                <small>
                  {[
                    model.ownedBy && t('provider.owner', { value: model.ownedBy }),
                    model.contextLength &&
                      t('provider.contextLength', {
                        value: model.contextLength.toLocaleString(),
                      }),
                    model.createdAt && t('provider.created', { value: model.createdAt }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              )}
              {Object.keys(model.metadata).length > 0 && (
                <small>
                  {Object.entries(model.metadata)
                    .map(([key, value]) => `${key}: ${String(value)}`)
                    .join(' · ')}
                </small>
              )}
            </span>
            <input
              type="checkbox"
              checked={draft.enabledModelIds.includes(model.id)}
              aria-label={t('provider.enableModel', { name: model.name ?? model.id })}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  enabledModelIds: event.currentTarget.checked
                    ? [...draft.enabledModelIds, model.id]
                    : draft.enabledModelIds.filter((id) => id !== model.id),
                })
              }
            />
            <span className="quick-settings-switch" aria-hidden="true" />
          </label>
        ))}
        {draft.models.length === 0 && (
          <p className="empty-state compact">{t('provider.modelEmpty')}</p>
        )}
        {draft.models.length > 0 && filteredModels.length === 0 && (
          <p className="empty-state compact">{t('provider.modelNoMatch')}</p>
        )}
      </div>
      <div className="manual-model-add">
        <input
          value={manualId}
          maxLength={500}
          placeholder="Model ID"
          onChange={(event) => setManualId(event.currentTarget.value)}
        />
        <button type="button" onClick={addManual} disabled={!manualId.trim()}>
          <Plus size={15} />
          {t('common.add')}
        </button>
      </div>
      {error && (
        <p className="main-error" role="alert">
          {error}
        </p>
      )}
      <div className="provider-flow-actions">
        {draft.id && (
          <button
            className="text-button danger"
            type="button"
            onClick={() => {
              if (!window.confirm(t('provider.deleteConfirm'))) return;
              void window.fumu
                .deleteProvider(draft.id!)
                .then(deleted)
                .catch(() => setError(t('common.genericError')));
            }}
          >
            <Trash2 size={15} />
            {t('common.delete')}
          </button>
        )}
        <span />
        <button className="primary-button no-margin" type="submit" disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  );
}

function UsedModels({ settings }: { readonly settings: SettingsSnapshot }) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [models, setModels] = useState(settings.usedModels);
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!saving) setModels(settings.usedModels);
  }, [saving, settings.usedModels]);
  const options = useMemo(
    () =>
      settings.providers
        .flatMap((provider) => provider.enabledModelIds.map((modelId) => ({ provider, modelId })))
        .filter(
          ({ provider, modelId }) =>
            !models.some((item) => item.providerId === provider.id && item.modelId === modelId),
        ),
    [models, settings.providers],
  );

  const save = async (next: readonly UsedModelReference[]): Promise<void> => {
    if (saving) return;
    const previous = models;
    setModels(next);
    setSaving(true);
    try {
      const snapshot = await window.fumu.updateUsedModels({ models: next });
      setModels(snapshot.usedModels);
      setError(null);
      setAdding(false);
    } catch {
      setModels(previous);
      setError(t('common.genericError'));
    } finally {
      setSaving(false);
    }
  };
  const move = (from: number, to: number): void => {
    if (saving || from === to || to < 0 || to >= models.length) return;
    const next = [...models];
    const [item] = next.splice(from, 1);
    if (item) next.splice(to, 0, item);
    const moved = next[to];
    setAnnouncement(
      moved ? t('provider.modelMoved', { name: moved.modelId, position: to + 1 }) : '',
    );
    void save(next);
  };

  return (
    <section className="used-models-section settings-section nani-settings-card">
      <div className="used-models-heading">
        <div>
          <h2>{t('provider.usedModels')}</h2>
          <p>{t('provider.usedModelsDetail')}</p>
        </div>
        <button
          className="text-button"
          type="button"
          disabled={saving}
          onClick={() => setAdding(!adding)}
        >
          <Plus size={15} />
          {t('common.add')}
        </button>
      </div>
      {adding && (
        <div className="used-model-picker">
          {options.map(({ provider, modelId }) => (
            <button
              key={`${provider.id}-${modelId}`}
              type="button"
              disabled={saving}
              onClick={() => void save([...models, { providerId: provider.id, modelId }])}
            >
              <ProviderMark kind={provider.kind} />
              <span>
                <strong>{provider.name}</strong> / {modelId}
              </span>
              <Plus size={15} />
            </button>
          ))}
          {options.length === 0 && <p>{t('provider.noModelsToAdd')}</p>}
        </div>
      )}
      <div className="used-model-list">
        {models.map((reference, index) => {
          const provider = settings.providers.find((item) => item.id === reference.providerId);
          if (!provider) return null;
          return (
            <div
              className={index === 0 ? 'used-model-row main' : 'used-model-row'}
              key={`${reference.providerId}-${reference.modelId}`}
              draggable={!saving}
              onDragStart={() => setDragging(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragging !== null) move(dragging, index);
                setDragging(null);
              }}
            >
              <GripVertical size={18} aria-hidden="true" />
              <span className="used-model-rank">{index + 1}.</span>
              <span className="used-model-label">
                <strong>{provider.name}</strong> / {reference.modelId}
              </span>
              {index === 0 && <span className="main-model-badge">{t('provider.mainModel')}</span>}
              <span className="used-model-actions">
                <button
                  type="button"
                  disabled={saving || index === 0}
                  aria-label={t('provider.moveUp', {
                    name: `${provider.name} / ${reference.modelId}`,
                  })}
                  onClick={() => move(index, index - 1)}
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  type="button"
                  disabled={saving || index === models.length - 1}
                  aria-label={t('provider.moveDown', {
                    name: `${provider.name} / ${reference.modelId}`,
                  })}
                  onClick={() => move(index, index + 1)}
                >
                  <ChevronDown size={15} />
                </button>
                <button
                  type="button"
                  disabled={saving}
                  aria-label={t('provider.removeModel', {
                    name: `${provider.name} / ${reference.modelId}`,
                  })}
                  onClick={() => void save(models.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <X size={15} />
                </button>
              </span>
            </div>
          );
        })}
        {models.length === 0 && <p className="empty-state compact">{t('provider.noUsedModels')}</p>}
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {error && (
        <p className="main-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function ProviderModelSettings({
  settings,
  close,
  back,
  rootRef,
  initialProviderKind,
  startAtPresets = false,
  autoSelectFirstModel = true,
  onConfigured,
}: {
  readonly settings: SettingsSnapshot;
  readonly close: () => void;
  readonly back: () => void;
  readonly rootRef?: React.RefObject<HTMLElement | null>;
  readonly initialProviderKind?: ProviderKind;
  readonly startAtPresets?: boolean;
  readonly autoSelectFirstModel?: boolean;
  readonly onConfigured?: () => void;
}) {
  const { t } = useI18n();
  const initialPreset = initialProviderKind === undefined ? null : presetOf(initialProviderKind);
  const [screen, setScreen] = useState<'overview' | 'presets' | 'editor'>(() =>
    initialProviderKind ? 'editor' : startAtPresets ? 'presets' : 'overview',
  );
  const [draft, setDraft] = useState<Draft | null>(() =>
    initialPreset
      ? draftForPreset(
          initialPreset,
          initialPreset.labelKey ? t(initialPreset.labelKey) : initialPreset.label,
        )
      : null,
  );
  const titleId = useId();
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const title =
    screen === 'overview'
      ? t('provider.manageModels')
      : screen === 'presets'
        ? t('provider.addProvider')
        : draft?.id
          ? draft?.isNew
            ? t('provider.addProvider')
            : t('provider.editProvider')
          : t('provider.addProvider');
  const goBack = (): void => {
    if (screen === 'overview') back();
    else if (screen === 'editor' && draft?.isNew) setScreen('presets');
    else setScreen('overview');
  };
  useEffect(() => {
    backButtonRef.current?.focus();
  }, [screen]);
  return (
    <section
      ref={rootRef}
      className="provider-model-settings"
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          goBack();
        }
      }}
    >
      <header className="settings-subview-header">
        <button
          ref={backButtonRef}
          className="settings-subview-back icon-button"
          type="button"
          aria-label={t('common.back')}
          onClick={goBack}
        >
          <ChevronLeft size={20} />
        </button>
        <div>
          <span className="settings-eyebrow">{t('common.settings')}</span>
          <h1 id={titleId}>{title}</h1>
        </div>
        <button
          className="settings-subview-close icon-button"
          type="button"
          aria-label={t('settings.closeSettings')}
          onClick={close}
        >
          <X size={20} />
        </button>
      </header>
      <div className="provider-model-content">
        {screen === 'overview' && (
          <>
            <section className="settings-section nani-settings-card provider-overview-section">
              <div className="settings-heading-row">
                <h2>{t('provider.providers')}</h2>
                <button className="text-button" type="button" onClick={() => setScreen('presets')}>
                  <Plus size={15} />
                  {t('common.add')}
                </button>
              </div>
              <div className="style-list provider-management-list">
                {settings.providers.map((provider) => (
                  <button
                    className="style-row provider-choice-row"
                    type="button"
                    key={provider.id}
                    onClick={() => {
                      setDraft(draftForProvider(provider));
                      setScreen('editor');
                    }}
                  >
                    <ProviderMark kind={provider.kind} />
                    <span className="provider-choice-copy">
                      <strong>{provider.name}</strong>
                      <small>
                        {provider.enabledModelIds.length === 0
                          ? t('common.notConfigured')
                          : t('provider.enabledModels', {
                              count: provider.enabledModelIds.length,
                              models: provider.enabledModelIds.slice(0, 2).join(', '),
                            })}
                      </small>
                    </span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                ))}
                {settings.providers.length === 0 && (
                  <p className="empty-state compact">{t('provider.noProviders')}</p>
                )}
              </div>
            </section>
            <UsedModels settings={settings} />
          </>
        )}
        {screen === 'presets' && (
          <PresetPicker
            settings={settings}
            select={(preset) => {
              setDraft(draftForPreset(preset, preset.labelKey ? t(preset.labelKey) : preset.label));
              setScreen('editor');
            }}
          />
        )}
        {screen === 'editor' && draft && (
          <ProviderEditor
            key={`${draft.id ?? 'new'}-${draft.kind}`}
            draft={draft}
            settings={settings}
            deleted={() => setScreen('overview')}
            done={async (snapshot, savedDraft) => {
              // 使用モデルがない状態では、保存だけで翻訳可能な状態にする。プロバイダーが表示されているのに
              // 使用モデルが空のままだと、登録成功に見えても翻訳ボタンが動かないためである。
              if (autoSelectFirstModel && snapshot.usedModels.length === 0) {
                const savedProvider =
                  (savedDraft.id === null
                    ? snapshot.providers.find(
                        (provider) => !settings.providers.some((item) => item.id === provider.id),
                      )
                    : snapshot.providers.find((provider) => provider.id === savedDraft.id)) ?? null;
                const modelId = savedProvider?.enabledModelIds[0];
                if (savedProvider && modelId) {
                  await window.fumu.updateUsedModels({
                    models: [{ providerId: savedProvider.id, modelId }],
                  });
                  onConfigured?.();
                }
              }
              setScreen('overview');
            }}
          />
        )}
      </div>
    </section>
  );
}
