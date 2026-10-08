import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, SlidersHorizontal } from 'lucide-react';
import type {
  GeneralSettingsUpdate,
  SettingsSnapshot,
  TranslationStyle,
} from '../../../shared/settings-contracts';
import { SoftSelect } from './SettingsView';
import { useI18n } from '../i18n';

function enabledModelOptions(settings: SettingsSnapshot) {
  return settings.providers.flatMap((provider) =>
    provider.enabledModelIds.map((modelId) => ({
      value: `${provider.id}\u0000${modelId}`,
      label: `${provider.name} · ${modelId}`,
      providerId: provider.id,
      modelId,
    })),
  );
}

function QuickSettingsPanel({
  settings,
  id,
  closing,
  onOpenSettings,
}: {
  readonly settings: SettingsSnapshot;
  readonly id: string;
  readonly closing: boolean;
  readonly onOpenSettings: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const currentModel = settings.usedModels[0];
  const modelOptions = enabledModelOptions(settings);
  // 「未設定」は解除操作ではなく、実際に使用モデルがない場合の状態表示だけに使う。
  const displayedModelOptions =
    currentModel === undefined
      ? [{ value: '', label: t('common.notConfigured') }, ...modelOptions]
      : modelOptions;
  const update = (patch: GeneralSettingsUpdate): void => {
    void window.fumu
      .updateGeneralSettings(patch)
      .then(() => setError(null))
      .catch(() => setError(t('common.settingsSaveError')));
  };

  return (
    <div
      id={id}
      className={closing ? 'quick-settings-panel closing' : 'quick-settings-panel'}
      role="dialog"
      aria-label={t('quick.title')}
    >
      <div className="quick-settings-row">
        <strong>{t('quick.aiModel')}</strong>
        <SoftSelect<string>
          label={t('quick.aiModel')}
          value={
            currentModel === undefined
              ? ''
              : `${currentModel.providerId}\u0000${currentModel.modelId}`
          }
          options={displayedModelOptions}
          onChange={(value) => {
            const selected = modelOptions.find((option) => option.value === value);
            const models =
              selected === undefined
                ? []
                : [
                    { providerId: selected.providerId, modelId: selected.modelId },
                    ...settings.usedModels.filter(
                      (model) =>
                        model.providerId !== selected.providerId ||
                        model.modelId !== selected.modelId,
                    ),
                  ];
            void window.fumu
              .updateUsedModels({ models })
              .then(() => setError(null))
              .catch(() => setError(t('quick.modelChangeError')));
          }}
        />
      </div>
      <div className="quick-settings-row">
        <strong>{t('quick.translationStyle')}</strong>
        <SoftSelect<TranslationStyle>
          label={t('quick.translationStyle')}
          value={settings.translationStyle}
          options={[
            { value: 'literal', label: t('quick.literal') },
            { value: 'natural', label: t('quick.natural') },
          ]}
          onChange={(translationStyle) => update({ translationStyle })}
        />
      </div>
      <label className="quick-settings-toggle">
        <span>
          <strong>{t('quick.enterToSend')}</strong>
          <small>{t('quick.shiftEnter')}</small>
        </span>
        <input
          type="checkbox"
          checked={settings.enterToSend}
          aria-label={t('quick.enterToSend')}
          onChange={(event) => update({ enterToSend: event.currentTarget.checked })}
        />
        <span className="quick-settings-switch" aria-hidden="true" />
      </label>
      {error && (
        <p className="quick-settings-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="quick-settings-more"
        type="button"
        onClick={() => {
          onOpenSettings();
        }}
      >
        {t('quick.more')}
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export function QuickSettingsControl({
  settings,
  openSettings,
  placement = 'above',
}: {
  readonly settings: SettingsSnapshot | null;
  readonly openSettings: () => void;
  readonly placement?: 'above' | 'below';
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const panelId = useId();

  const close = (): void => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    setOpen(false);
    closeTimerRef.current = window.setTimeout(() => {
      setRendered(false);
      closeTimerRef.current = null;
    }, 140);
  };
  const show = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setRendered(true);
    setOpen(true);
  };

  useEffect(() => {
    if (!rendered) return;
    const closeOutside = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (
        anchorRef.current?.contains(event.target) ||
        (event.target instanceof Element && event.target.closest('.soft-select-menu') !== null)
      ) {
        return;
      }
      close();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      window.requestAnimationFrame(() => buttonRef.current?.focus());
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [rendered]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  return (
    <div
      ref={anchorRef}
      className={`quick-settings-anchor${placement === 'below' ? ' below' : ''}`}
    >
      <button
        ref={buttonRef}
        className={
          placement === 'below' ? 'another-text-quick-settings-button' : 'nani-icon-button'
        }
        type="button"
        aria-label={t('quick.title')}
        aria-haspopup="dialog"
        aria-controls={rendered ? panelId : undefined}
        aria-expanded={open}
        title={placement === 'below' ? t('quick.title') : undefined}
        onClick={() => {
          if (settings === null) {
            openSettings();
          } else if (open) {
            close();
          } else {
            show();
          }
        }}
      >
        <SlidersHorizontal size={19} aria-hidden="true" />
      </button>
      {rendered && settings !== null && (
        <QuickSettingsPanel
          settings={settings}
          id={panelId}
          closing={!open}
          onOpenSettings={() => {
            buttonRef.current?.focus();
            close();
            openSettings();
          }}
        />
      )}
    </div>
  );
}
