import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronRight,
  Image as ImageIcon,
  MessagesSquare,
  PenLine,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from 'lucide-react';
import type { DesktopStatus, PopupViewState } from '../../../shared/contracts';
import type { HistoryDetail, HistoryListItem } from '../../../shared/history-contracts';
import type { GeneralSettingsUpdate } from '../../../shared/settings-contracts';
import {
  DEFAULT_TRANSLATE_SHORTCUT,
  FIXED_ADJUSTMENT_STYLE_IDS,
  MAX_WRITING_STYLE_INSTRUCTION_LENGTH,
  MAX_WRITING_STYLE_NAME_LENGTH,
  NATIVE_LANGUAGE_OPTIONS,
  type NativeLanguage,
  type SettingsSnapshot,
  type TranslationStyle,
  type WritingStyle,
} from '../../../shared/settings-contracts';
import { TranslationResultPanel as SharedTranslationResultPanel } from '../TranslationResultPanel';
import { IdleMascot } from '../IdleMascot';
import { Onboarding } from '../Onboarding';
import { SettingsView, SoftSelect } from './SettingsView';
import {
  appliedTranslationInstructions,
  type AppliedTranslationInstruction,
} from './applied-translation-instructions';
import { InlineContextEditor } from './InlineContextEditor';
import { composeWritingStyleInstruction } from './writing-style-selection';
import { useI18n } from '../i18n';
import { localizedWritingStyles } from '../i18n/writing-styles';
import { displayedTargetLanguage } from './language-target';
import { shouldOpenExternalTranslation } from './external-translation-state';
import { displayAccelerator } from './shortcut-display';
import { ConversationTranslationFlow, ConversationTurnResult } from './ConversationTranslationFlow';
import {
  completedConversationResult,
  conversationContextForTurns,
  conversationReplyTargetLanguage,
  conversationTranslationTurnsFromHistory,
  translationStateFromHistory,
  type ConversationDirection,
  type ConversationTurn,
} from './conversation-session';

type MainPage = 'translate' | 'history';
type ComposerMode = 'text' | 'conversation';
type SettingsTarget = 'general' | 'writing-styles';

interface ResumableConversation {
  readonly sessionId: string;
  readonly turns: readonly ConversationTurn[];
}

const INITIAL_STATUS: DesktopStatus = {
  hotkey: DEFAULT_TRANSLATE_SHORTCUT,
  hotkeyState: 'disabled',
  selectionServiceRunning: false,
  popupVisible: false,
  activeProviderName: null,
  activeModelName: null,
  translationConfigured: false,
};
const INITIAL_POPUP: PopupViewState = { phase: 'idle', requestId: null };

function useDesktopStatus(): DesktopStatus {
  const [status, setStatus] = useState(INITIAL_STATUS);
  useEffect(() => {
    let active = true;
    void window.fumu
      .getStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => undefined);
    const unsubscribe = window.fumu.onStatus(setStatus);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return status;
}

function useSettings(loadError: string): {
  settings: SettingsSnapshot | null;
  error: string | null;
} {
  const [state, setState] = useState<{ settings: SettingsSnapshot | null; error: string | null }>({
    settings: null,
    error: null,
  });
  useEffect(() => {
    let active = true;
    void window.fumu
      .getSettings()
      .then((value) => {
        if (active) setState({ settings: value, error: null });
      })
      .catch(() => {
        if (active) setState({ settings: null, error: loadError });
      });
    const unsubscribe = window.fumu.onSettingsChanged((settings) =>
      setState({ settings, error: null }),
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [loadError]);
  return state;
}

function useRecentHistory(): readonly HistoryListItem[] {
  const [items, setItems] = useState<readonly HistoryListItem[]>([]);
  useEffect(() => {
    let active = true;
    const load = (): void => {
      void window.fumu
        .listHistory({ query: '', limit: 30 })
        .then((value) => {
          if (active) setItems(value);
        })
        .catch(() => undefined);
    };
    load();
    const unsubscribe = window.fumu.onHistoryChanged(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return items;
}

function useMainTranslation(): PopupViewState {
  const [state, setState] = useState<PopupViewState>(INITIAL_POPUP);
  useEffect(() => window.fumu.onPopupState(setState), []);
  return state;
}

function TargetLanguageSelect({
  value,
  onChange,
  className,
}: {
  readonly value: NativeLanguage;
  readonly onChange: (value: NativeLanguage) => void;
  readonly className: string;
}): React.JSX.Element {
  const { t, formatLanguageName } = useI18n();
  const targetLanguageOptions = useMemo(
    () =>
      NATIVE_LANGUAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: formatLanguageName(option.value),
      })),
    [formatLanguageName],
  );
  return (
    <div className={className}>
      <SoftSelect
        label={t('main.targetLanguage')}
        value={value}
        options={targetLanguageOptions}
        selectedPrefix="⇄ "
        onChange={onChange}
      />
    </div>
  );
}

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
  onClose,
}: {
  readonly settings: SettingsSnapshot;
  readonly id: string;
  readonly closing: boolean;
  readonly onOpenSettings: () => void;
  readonly onClose: () => void;
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
          onClose();
          onOpenSettings();
        }}
      >
        {t('quick.more')}
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function Composer({
  settings,
  status,
  state,
  targetLanguage,
  targetLanguageOverride,
  onTargetLanguageChange,
  openSettings,
  openWritingStyles,
  onConversationRoutingChange,
  dismissedTranslationRequestId,
  initialConversation,
}: {
  settings: SettingsSnapshot | null;
  status: DesktopStatus;
  state: PopupViewState;
  targetLanguage: NativeLanguage;
  targetLanguageOverride: NativeLanguage | null;
  onTargetLanguageChange(value: NativeLanguage): void;
  openSettings(): void;
  openWritingStyles(): void;
  onConversationRoutingChange(mode: ComposerMode, direction: ConversationDirection): void;
  dismissedTranslationRequestId: string | null;
  initialConversation: ResumableConversation | null;
}) {
  const { t } = useI18n();
  const initialConversationLastTurn = initialConversation?.turns.at(-1) ?? null;
  const [mode, setMode] = useState<ComposerMode>(
    initialConversation === null ? 'text' : 'conversation',
  );
  const [conversationDirection, setConversationDirection] = useState<ConversationDirection>(
    initialConversation?.turns[0]?.direction ?? 'incoming',
  );
  const [conversationTurns, setConversationTurns] = useState<readonly ConversationTurn[]>(
    initialConversation?.turns.slice(0, -1) ?? [],
  );
  const [resumedConversationTurn, setResumedConversationTurn] = useState<ConversationTurn | null>(
    initialConversationLastTurn,
  );
  const [conversationSessionId, setConversationSessionId] = useState(
    () => initialConversation?.sessionId ?? crypto.randomUUID(),
  );
  const [activeConversationSubmission, setActiveConversationSubmission] = useState<{
    readonly id: string;
    readonly direction: ConversationDirection;
    readonly sourceText: string;
    readonly appliedInstructions: readonly AppliedTranslationInstruction[];
    readonly previousRequestId: string | null;
  } | null>(null);
  const [text, setText] = useState('');
  const [inlineContexts, setInlineContexts] = useState<readonly string[]>([]);
  const [resultInstructions, setResultInstructions] = useState<
    readonly AppliedTranslationInstruction[]
  >([]);
  const [styleAdjustEnabled, setStyleAdjustEnabled] = useState(false);
  const [styleAdjustRendered, setStyleAdjustRendered] = useState(false);
  const [selectedWritingStyleIds, setSelectedWritingStyleIds] = useState<readonly string[]>([]);
  const [additionalInstructionOpen, setAdditionalInstructionOpen] = useState(false);
  const [additionalInstruction, setAdditionalInstruction] = useState('');
  const [saveStyleOpen, setSaveStyleOpen] = useState(false);
  const [saveStyleName, setSaveStyleName] = useState('');
  const [styleSaveError, setStyleSaveError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(initialConversation === null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false);
  const [quickSettingsRendered, setQuickSettingsRendered] = useState(false);
  const quickSettingsRef = useRef<HTMLDivElement>(null);
  const quickSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const quickSettingsCloseTimerRef = useRef<number | null>(null);
  const styleAdjustCloseTimerRef = useRef<number | null>(null);
  const submittingRef = useRef(false);
  const quickSettingsId = useId();
  const conversationReady =
    mode !== 'conversation' ||
    conversationDirection === 'outgoing' ||
    settings?.nativeLanguage != null;
  const composerStyles = localizedWritingStyles(
    settings?.writingStyles.filter(
      (style) =>
        style.hidden !== true &&
        style.deleted !== true &&
        !FIXED_ADJUSTMENT_STYLE_IDS.includes(
          style.id as (typeof FIXED_ADJUSTMENT_STYLE_IDS)[number],
        ),
    ) ?? [],
    t,
  );
  const selectedWritingStyles = composerStyles.filter((style) =>
    selectedWritingStyleIds.includes(style.id),
  );
  const additionalInstructionValue = additionalInstruction.trim();
  const activeWritingStyle = composeWritingStyleInstruction({
    mode,
    enabled: styleAdjustEnabled,
    styles: selectedWritingStyles,
    additionalInstruction,
    additionalInstructionLabel: t('main.additionalInstruction'),
  });
  useEffect(() => {
    // ショートカットから届く選択結果はComposerの送信操作を経由しないため、
    // 外部選択のrequestだけ明示的に結果表示へ切り替える。
    if (shouldOpenExternalTranslation(state, dismissedTranslationRequestId)) {
      setDrafting(false);
    }
  }, [dismissedTranslationRequestId, state.phase, state.requestId]);
  const submit = (conversationReply?: {
    readonly text: string;
    readonly direction: ConversationDirection;
  }): void => {
    const value = (conversationReply?.text ?? text).trim();
    const submittedDirection = conversationReply?.direction ?? conversationDirection;
    const submittedConversationReady =
      mode !== 'conversation' ||
      submittedDirection === 'outgoing' ||
      settings?.nativeLanguage != null;
    if (
      submittingRef.current ||
      !value ||
      !status.translationConfigured ||
      !submittedConversationReady
    )
      return;
    // 翻訳後も「実際に送信した指示」を表示するため、送信時点で表示用データを固定する。
    // 文体UIの現在値から都度再計算すると、翻訳中の設定変更で結果の表示とリクエストがずれる。
    const submittedInstructions = appliedTranslationInstructions({
      inlineContexts,
      writingStyles: activeWritingStyle === null ? [] : selectedWritingStyles,
      additionalInstruction: activeWritingStyle === null ? '' : additionalInstruction,
    });
    const activeState =
      state.phase === 'selection' &&
      activeConversationSubmission !== null &&
      state.requestId !== activeConversationSubmission.previousRequestId
        ? state
        : null;
    const liveCompletedTurn: ConversationTurn | null =
      activeState !== null &&
      activeConversationSubmission !== null &&
      completedConversationResult(activeState.translation) !== null
        ? {
            id: activeConversationSubmission.id,
            direction: activeConversationSubmission.direction,
            sourceText: activeConversationSubmission.sourceText,
            translation: activeState.translation,
            appliedInstructions: activeConversationSubmission.appliedInstructions,
          }
        : null;
    const activeCompletedTurn = liveCompletedTurn ?? resumedConversationTurn;
    const previousConversationTurns =
      mode === 'conversation' && activeCompletedTurn !== null
        ? [...conversationTurns, activeCompletedTurn]
        : conversationTurns;
    const conversationContext =
      mode === 'conversation' ? conversationContextForTurns(previousConversationTurns) : [];
    const requestedTargetLanguage =
      mode !== 'conversation'
        ? targetLanguageOverride
        : submittedDirection === 'incoming'
          ? null
          : conversationReplyTargetLanguage(previousConversationTurns, targetLanguage);
    // A ref closes the same-event-loop double-submit window before React can render disabled UI.
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    if (mode === 'conversation') {
      setConversationTurns(previousConversationTurns);
      setResumedConversationTurn(null);
      setActiveConversationSubmission({
        id: crypto.randomUUID(),
        direction: submittedDirection,
        sourceText: value,
        appliedInstructions: submittedInstructions,
        previousRequestId: state.phase === 'selection' ? state.requestId : null,
      });
    }
    void window.fumu
      .translateText(
        value,
        mode === 'conversation' ? submittedDirection : null,
        activeWritingStyle,
        inlineContexts,
        submittedInstructions,
        requestedTargetLanguage,
        conversationContext,
        mode === 'conversation' ? conversationSessionId : null,
      )
      // The main process publishes the new selection state before this IPC invocation resolves.
      // Keep the rich editor mounted until then so a rejected invocation cannot remount an empty
      // editor while leaving an invisible parent submission value behind.
      .then(() => {
        submittingRef.current = false;
        setSubmitting(false);
        setResultInstructions(submittedInstructions);
        setDrafting(false);
      })
      .catch(() => {
        submittingRef.current = false;
        setSubmitting(false);
        setSubmitError(t('main.startError'));
      });
  };
  const selectWritingStyle = (style: WritingStyle): void => {
    setSelectedWritingStyleIds((current) =>
      current.includes(style.id) ? current.filter((id) => id !== style.id) : [...current, style.id],
    );
    setSaveStyleOpen(false);
    setStyleSaveError(null);
  };
  const openAdditionalInstruction = (): void => {
    setAdditionalInstructionOpen(true);
    setSaveStyleOpen(false);
    setStyleSaveError(null);
  };
  const saveAdditionalInstruction = (): void => {
    if (settings === null) return;
    const name = saveStyleName.trim();
    const instruction = additionalInstruction.trim();
    if (name.length === 0) {
      setStyleSaveError(t('main.styleNameRequired'));
      return;
    }
    if (instruction.length === 0) {
      setStyleSaveError(t('main.styleInstructionRequired'));
      return;
    }
    const style: WritingStyle = {
      id: crypto.randomUUID(),
      name,
      instruction,
      icon: '✨',
    };
    void window.fumu
      .updateGeneralSettings({ writingStyles: [...settings.writingStyles, style] })
      .then(() => {
        setSelectedWritingStyleIds((current) => [...current, style.id]);
        setAdditionalInstructionOpen(false);
        setSaveStyleOpen(false);
        setAdditionalInstruction('');
        setSaveStyleName('');
        setStyleSaveError(null);
      })
      .catch(() => setStyleSaveError(t('main.styleSaveError')));
  };
  const toggleStyleAdjustment = (): void => {
    if (styleAdjustCloseTimerRef.current !== null) {
      window.clearTimeout(styleAdjustCloseTimerRef.current);
      styleAdjustCloseTimerRef.current = null;
    }
    if (styleAdjustEnabled) {
      setStyleAdjustEnabled(false);
      styleAdjustCloseTimerRef.current = window.setTimeout(() => {
        setStyleAdjustRendered(false);
        styleAdjustCloseTimerRef.current = null;
      }, 240);
      return;
    }
    setStyleAdjustRendered(true);
    setStyleAdjustEnabled(true);
  };
  const closeQuickSettings = (): void => {
    if (quickSettingsCloseTimerRef.current !== null) {
      window.clearTimeout(quickSettingsCloseTimerRef.current);
    }
    setQuickSettingsOpen(false);
    quickSettingsCloseTimerRef.current = window.setTimeout(() => {
      setQuickSettingsRendered(false);
      quickSettingsCloseTimerRef.current = null;
    }, 140);
  };
  const showQuickSettings = (): void => {
    if (quickSettingsCloseTimerRef.current !== null) {
      window.clearTimeout(quickSettingsCloseTimerRef.current);
      quickSettingsCloseTimerRef.current = null;
    }
    setQuickSettingsRendered(true);
    setQuickSettingsOpen(true);
  };
  useEffect(
    () => () => {
      if (quickSettingsCloseTimerRef.current !== null) {
        window.clearTimeout(quickSettingsCloseTimerRef.current);
      }
      if (styleAdjustCloseTimerRef.current !== null) {
        window.clearTimeout(styleAdjustCloseTimerRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    if (!quickSettingsRendered) return;
    const closeOutside = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return;
      const target = event.target;
      // SoftSelect renders its listbox into body so it can escape clipped
      // containers. Treat that portaled listbox as part of this panel while
      // an option is being selected.
      if (
        quickSettingsRef.current?.contains(target) ||
        (target instanceof Element && target.closest('.soft-select-menu') !== null)
      ) {
        return;
      }
      closeQuickSettings();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      closeQuickSettings();
      window.requestAnimationFrame(() => quickSettingsButtonRef.current?.focus());
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [quickSettingsRendered]);
  const activeConversationTurn =
    activeConversationSubmission !== null
      ? {
          id: activeConversationSubmission.id,
          direction: activeConversationSubmission.direction,
          sourceText: activeConversationSubmission.sourceText,
          state:
            state.phase === 'selection' &&
            state.requestId !== activeConversationSubmission.previousRequestId
              ? state.translation
              : null,
          appliedInstructions: activeConversationSubmission.appliedInstructions,
          interactive: true,
        }
      : resumedConversationTurn === null
        ? null
        : {
            id: resumedConversationTurn.id,
            direction: resumedConversationTurn.direction,
            sourceText: resumedConversationTurn.sourceText,
            state: resumedConversationTurn.translation,
            appliedInstructions: resumedConversationTurn.appliedInstructions,
            interactive: false,
          };
  const showingConversationResult =
    mode === 'conversation' && !drafting && activeConversationTurn !== null;
  const showingStandardResult =
    state.phase === 'selection' && !drafting && !showingConversationResult;
  const showingResult = showingConversationResult || showingStandardResult;
  return (
    <div className="translate-workspace composer-workspace">
      {showingResult ? (
        <button
          className="nani-new-bar"
          type="button"
          onClick={() => {
            // The rich editor owns its DOM while mounted. Reset the parent submission state at
            // the same boundary so an empty remounted editor can never submit hidden prior input.
            setText('');
            setInlineContexts([]);
            setResultInstructions([]);
            setConversationTurns([]);
            setConversationSessionId(crypto.randomUUID());
            setActiveConversationSubmission(null);
            setResumedConversationTurn(null);
            submittingRef.current = false;
            setSubmitting(false);
            setSubmitError(null);
            setDrafting(true);
          }}
        >
          <SlidersHorizontal size={19} />
          <span>{t('main.anotherText')}</span>
          <PenLine size={19} />
        </button>
      ) : (
        <section
          className={
            styleAdjustEnabled ? 'nani-composer-shell style-adjust-enabled' : 'nani-composer-shell'
          }
        >
          <header>
            <button
              className={
                styleAdjustEnabled ? 'composer-style-toggle active' : 'composer-style-toggle'
              }
              type="button"
              aria-pressed={styleAdjustEnabled}
              onClick={toggleStyleAdjustment}
            >
              <span className="toggle-dot" aria-hidden="true" />
              <span>{t('main.adjustStyle')}</span>
            </button>
            {(mode !== 'conversation' || conversationDirection === 'outgoing') && (
              <TargetLanguageSelect
                className="composer-language"
                value={targetLanguage}
                onChange={onTargetLanguageChange}
              />
            )}
          </header>
          {styleAdjustRendered && settings !== null && (
            <div
              className={
                styleAdjustEnabled ? 'composer-style-reveal' : 'composer-style-reveal closing'
              }
            >
              <div
                className={
                  styleAdjustEnabled ? 'composer-style-picker' : 'composer-style-picker closing'
                }
                aria-label={t('main.style')}
              >
                {composerStyles.map((style) => (
                  <button
                    className={selectedWritingStyleIds.includes(style.id) ? 'selected' : undefined}
                    type="button"
                    key={style.id}
                    aria-pressed={selectedWritingStyleIds.includes(style.id)}
                    onClick={() => selectWritingStyle(style)}
                  >
                    <span aria-hidden="true">{style.icon ?? '✨'}</span>
                    {style.name}
                  </button>
                ))}
                <button
                  className={
                    additionalInstructionOpen || additionalInstructionValue.length > 0
                      ? 'selected additional'
                      : 'additional'
                  }
                  type="button"
                  aria-pressed={additionalInstructionOpen || additionalInstructionValue.length > 0}
                  onClick={openAdditionalInstruction}
                >
                  <span aria-hidden="true">＋</span>
                  {t('main.additionalInstruction')}
                </button>
                {additionalInstructionOpen && (
                  <div className="composer-additional-instruction">
                    <textarea
                      aria-label={t('main.additionalInstruction')}
                      value={additionalInstruction}
                      maxLength={MAX_WRITING_STYLE_INSTRUCTION_LENGTH}
                      placeholder={t('main.additionalInstructionPlaceholder')}
                      onChange={(event) => {
                        setAdditionalInstruction(event.currentTarget.value);
                        setStyleSaveError(null);
                      }}
                    />
                    <div className="composer-additional-actions">
                      {saveStyleOpen ? (
                        <>
                          <input
                            aria-label={t('main.styleNameAria')}
                            value={saveStyleName}
                            maxLength={MAX_WRITING_STYLE_NAME_LENGTH}
                            placeholder={t('main.styleNamePlaceholder')}
                            onChange={(event) => setSaveStyleName(event.currentTarget.value)}
                          />
                          <button type="button" onClick={saveAdditionalInstruction}>
                            {t('common.save')}
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setSaveStyleOpen(true)}>
                          {t('main.saveInstruction')}
                        </button>
                      )}
                    </div>
                    {styleSaveError && <p role="alert">{styleSaveError}</p>}
                  </div>
                )}
                <button
                  className="composer-style-settings"
                  type="button"
                  aria-label={t('main.manageStyles')}
                  onClick={openWritingStyles}
                >
                  <SettingsIcon size={18} />
                </button>
              </div>
            </div>
          )}
          <div className="nani-composer">
            {mode === 'conversation' && (
              <div className="conversation-controls">
                <div
                  className={`conversation-tabs ${conversationDirection}`}
                  role="tablist"
                  aria-label={t('main.conversationDirection')}
                >
                  <button
                    className={conversationDirection === 'incoming' ? 'active' : undefined}
                    type="button"
                    role="tab"
                    aria-selected={conversationDirection === 'incoming'}
                    onClick={() => {
                      setConversationDirection('incoming');
                      onConversationRoutingChange('conversation', 'incoming');
                    }}
                  >
                    {t('main.incoming')}
                  </button>
                  <button
                    className={conversationDirection === 'outgoing' ? 'active' : undefined}
                    type="button"
                    role="tab"
                    aria-selected={conversationDirection === 'outgoing'}
                    onClick={() => {
                      setConversationDirection('outgoing');
                      onConversationRoutingChange('conversation', 'outgoing');
                    }}
                  >
                    {t('main.outgoing')}
                  </button>
                </div>
                {conversationDirection === 'incoming' && settings?.nativeLanguage == null && (
                  <button
                    className="conversation-language-required"
                    type="button"
                    onClick={openSettings}
                  >
                    {t('main.setNativeLanguage')}
                  </button>
                )}
              </div>
            )}
            <InlineContextEditor
              label={mode === 'conversation' ? t('main.messageLabel') : t('main.textLabel')}
              placeholder={
                mode === 'conversation' ? t('main.messagePlaceholder') : t('main.textPlaceholder')
              }
              submitOnEnter={settings?.enterToSend === true}
              onChange={(value) => {
                setText(value.text);
                setInlineContexts(value.inlineContexts);
              }}
              onSubmit={submit}
            />
            <footer>
              <div className="quick-settings-anchor" ref={quickSettingsRef}>
                <button
                  ref={quickSettingsButtonRef}
                  className="nani-icon-button"
                  type="button"
                  aria-label={t('quick.title')}
                  aria-haspopup="dialog"
                  aria-controls={quickSettingsRendered ? quickSettingsId : undefined}
                  aria-expanded={quickSettingsOpen}
                  onClick={() => {
                    if (settings === null) {
                      openSettings();
                      return;
                    }
                    if (quickSettingsOpen) {
                      closeQuickSettings();
                    } else {
                      showQuickSettings();
                    }
                  }}
                >
                  <SlidersHorizontal size={19} />
                </button>
                {quickSettingsRendered && settings && (
                  <QuickSettingsPanel
                    settings={settings}
                    id={quickSettingsId}
                    closing={!quickSettingsOpen}
                    onOpenSettings={openSettings}
                    onClose={closeQuickSettings}
                  />
                )}
              </div>
              <div>
                <button
                  className="translate-button"
                  type="button"
                  disabled={
                    submitting ||
                    !text.trim() ||
                    !status.translationConfigured ||
                    !conversationReady
                  }
                  aria-busy={submitting}
                  onClick={() => submit()}
                >
                  {t('main.translate')} <ArrowUp size={17} />
                </button>
              </div>
            </footer>
          </div>
        </section>
      )}
      {submitError && (
        <p className="inline-error" role="alert">
          {submitError}
        </p>
      )}
      {showingConversationResult && activeConversationTurn !== null ? (
        <ConversationTranslationFlow
          turns={conversationTurns}
          activeTurn={activeConversationTurn}
          activeTurnInteractive={activeConversationTurn.interactive}
          enterToSend={settings?.enterToSend === true}
          submitting={submitting}
          onSubmit={(reply, direction) => submit({ text: reply, direction })}
        />
      ) : showingStandardResult && state.phase === 'selection' ? (
        <SharedTranslationResultPanel
          sourceText={state.selection.text}
          translation={state.translation}
          followUpMessages={state.followUpMessages}
          appliedInstructions={resultInstructions}
        />
      ) : null}
      {!showingResult && (
        <div className="translation-mode-cards">
          <button
            className="mode-card image-mode"
            type="button"
            disabled
            aria-describedby="image-coming-soon"
          >
            <ImageIcon size={23} />
            <span>
              <strong>{t('main.imageTitle')}</strong>
              <small>{t('main.imageDetail')}</small>
            </span>
            <em id="image-coming-soon">{t('main.comingSoon')}</em>
          </button>
          <button
            className={mode === 'conversation' ? 'mode-card selected' : 'mode-card'}
            type="button"
            onClick={() => {
              const nextMode = mode === 'conversation' ? 'text' : 'conversation';
              setMode(nextMode);
              onConversationRoutingChange(nextMode, conversationDirection);
            }}
          >
            <MessagesSquare size={23} />
            <span>
              <strong>{t('main.conversationTitle')}</strong>
              <small>{t('main.conversationDetail')}</small>
            </span>
          </button>
        </div>
      )}
      <p className="hotkey-hint">
        <span />{' '}
        <kbd>
          {displayAccelerator(status.hotkey, t('common.notConfigured')).replaceAll(' + ', ' ')}
        </kbd>{' '}
        {t('main.selectionHint')}
      </p>
    </div>
  );
}

function HistoryTranslationResult({
  detail,
  onResumeConversation,
}: {
  readonly detail: HistoryDetail;
  readonly onResumeConversation: (conversation: ResumableConversation) => void;
}) {
  const { t } = useI18n();
  const conversationTurns = conversationTranslationTurnsFromHistory(detail.results);
  if (conversationTurns.length > 0) {
    return (
      <div className="translate-workspace history-result-workspace">
        <section className="conversation-flow" aria-label={t('main.conversation')}>
          {conversationTurns.map((turn) => (
            <ConversationTurnResult key={turn.id} turn={turn} />
          ))}
          <button
            className="conversation-next-turn"
            type="button"
            onClick={() => onResumeConversation({ sessionId: detail.id, turns: conversationTurns })}
          >
            <PenLine size={17} aria-hidden="true" />
            {t('main.continueConversation')}
          </button>
        </section>
      </div>
    );
  }
  // 履歴専用の詳細画面を持たず、通常翻訳と同じ表示モデルへ復元する。
  // 過去の結果に対して現在のセッション操作を誤送信しないよう、調整と質問だけ無効化する。
  const translation = translationStateFromHistory(detail.results);
  if (translation === null) {
    return <p className="inline-error">{t('main.historyMissingResult')}</p>;
  }
  const initialTranslation = detail.results.find((result) => result.operation === 'translate');
  const historyInstructions = initialTranslation?.appliedInstructions ?? [];
  return (
    <div className="translate-workspace history-result-workspace">
      <SharedTranslationResultPanel
        sourceText={detail.sourceText}
        appliedInstructions={historyInstructions}
        translation={translation}
        followUpMessages={detail.messages.map((message) =>
          message.role === 'user'
            ? { id: message.id, role: 'user', text: message.text }
            : {
                id: message.id,
                role: 'assistant',
                phase: 'completed',
                text: message.text,
                errorMessage: null,
                retryable: false,
              },
        )}
        interactive={false}
      />
    </div>
  );
}

export function MainView(): React.JSX.Element {
  const { t } = useI18n();
  const [page, setPage] = useState<MainPage>('translate');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRendered, setSettingsRendered] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget>('general');
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [historyDetail, setHistoryDetail] = useState<HistoryDetail | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const [initialConversation, setInitialConversation] = useState<ResumableConversation | null>(
    null,
  );
  const [dismissedTranslationRequestId, setDismissedTranslationRequestId] = useState<string | null>(
    null,
  );
  const [targetLanguageOverride, setTargetLanguageOverride] = useState<NativeLanguage | null>(null);
  const [composerRouting, setComposerRouting] = useState<{
    readonly mode: ComposerMode;
    readonly direction: ConversationDirection;
  }>({ mode: 'text', direction: 'incoming' });
  const [onboardingRevealing, setOnboardingRevealing] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const logoTargetRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const settingsCloseTimerRef = useRef<number | null>(null);
  const status = useDesktopStatus();
  const settingsState = useSettings(t('common.settingsLoadError'));
  const recentHistory = useRecentHistory();
  const translationState = useMainTranslation();
  const targetLanguage = targetLanguageOverride ?? displayedTargetLanguage(settingsState.settings);
  const onboardingActive = settingsState.settings?.onboardingCompleted !== true;
  const goHome = (): void => {
    // 「新しく翻訳」は入力欄だけでなく、メイン画面に残る外部選択結果も閉じる操作。
    // 同じrequestをComposer再生成時に再検出すると、古い結果へ即座に戻ってしまう。
    setDismissedTranslationRequestId(
      translationState.phase === 'selection' ? translationState.requestId : null,
    );
    setPage('translate');
    setSelectedHistoryId(null);
    setHistoryDetail(null);
    setHistoryError(null);
    setInitialConversation(null);
    setComposerRouting({ mode: 'text', direction: 'incoming' });
    setComposerKey((value) => value + 1);
  };
  const appearance = settingsState.settings?.appearance ?? 'system';
  useEffect(() => {
    if (!shouldOpenExternalTranslation(translationState, dismissedTranslationRequestId)) {
      return;
    }
    // 履歴や設定を開いていても、ショートカットの翻訳結果を最前面の本文へ表示する。
    setPage('translate');
    setSelectedHistoryId(null);
    setHistoryDetail(null);
    setHistoryError(null);
    setInitialConversation(null);
    setSettingsOpen(false);
    setSettingsRendered(false);
  }, [dismissedTranslationRequestId, translationState.phase, translationState.requestId]);
  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
  }, [appearance]);
  const historyRows = useMemo(() => recentHistory.slice(0, 24), [recentHistory]);
  useEffect(() => {
    if (page !== 'history' || selectedHistoryId === null) return;
    let active = true;
    setHistoryLoading(true);
    setHistoryError(null);
    void window.fumu
      .getHistoryDetail(selectedHistoryId)
      .then((detail) => {
        if (!active) return;
        setHistoryDetail(detail);
        if (detail === null) setHistoryError(t('main.historyLoadError'));
      })
      .catch(() => {
        if (active) {
          setHistoryDetail(null);
          setHistoryError(t('main.historyLoadError'));
        }
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, selectedHistoryId, t]);
  const openSettings = (target: SettingsTarget = 'general'): void => {
    if (settingsCloseTimerRef.current !== null) {
      window.clearTimeout(settingsCloseTimerRef.current);
      settingsCloseTimerRef.current = null;
    }
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSettingsTarget(target);
    setSettingsRendered(true);
    setSettingsOpen(true);
  };
  const closeSettings = (): void => {
    if (settingsCloseTimerRef.current !== null) {
      window.clearTimeout(settingsCloseTimerRef.current);
    }
    setSettingsOpen(false);
    setSettingsTarget('general');
    settingsCloseTimerRef.current = window.setTimeout(() => {
      setSettingsRendered(false);
      settingsCloseTimerRef.current = null;
      window.requestAnimationFrame(() => restoreFocusRef.current?.focus());
    }, 180);
  };
  useEffect(
    () => () => {
      if (settingsCloseTimerRef.current !== null) {
        window.clearTimeout(settingsCloseTimerRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    if (!settingsRendered) return;
    const modal = modalRef.current;
    const focusable = (): HTMLElement[] =>
      Array.from(
        modal?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((control) => control.closest('[inert]') === null);
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Portal内の独自listboxが処理済みのEscape/Tabで、Dialog全体を閉じたり
      // Focus trapを二重実行したりしない。
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSettings();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [settingsRendered]);

  return (
    <main
      className={`main-window nani-main-window${onboardingActive ? ' is-onboarding' : ''}${onboardingRevealing ? ' is-onboarding-revealing' : ''}`}
    >
      <aside className="nani-sidebar" inert={settingsRendered || onboardingActive}>
        <div className="sidebar-top">
          <button
            ref={logoTargetRef}
            className="fumu-logo"
            type="button"
            aria-label={t('main.home')}
            onClick={goHome}
          >
            <IdleMascot disabled={onboardingActive || settingsRendered} />
          </button>
          {(composerRouting.mode !== 'conversation' ||
            composerRouting.direction === 'outgoing') && (
            <TargetLanguageSelect
              className="sidebar-language"
              value={targetLanguage}
              onChange={setTargetLanguageOverride}
            />
          )}
        </div>
        <button className="new-translation" type="button" onClick={goHome}>
          <PenLine size={19} />
          {t('main.newTranslation')}
        </button>
        <nav className="history-nav" aria-label={t('main.history')}>
          {historyRows.map((item) => (
            <button
              type="button"
              key={item.id}
              className={selectedHistoryId === item.id ? 'selected' : undefined}
              aria-current={selectedHistoryId === item.id ? 'page' : undefined}
              title={item.sourceText}
              onClick={() => {
                setSelectedHistoryId(item.id);
                setHistoryDetail(null);
                setPage('history');
              }}
            >
              {item.sourceText}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            className="sidebar-settings"
            type="button"
            aria-label={t('main.openSettings')}
            onClick={() => openSettings()}
          >
            <SettingsIcon size={19} />
          </button>
        </div>
      </aside>
      <section className="nani-canvas" inert={settingsRendered || onboardingActive}>
        {page === 'translate' ? (
          <Composer
            key={composerKey}
            settings={settingsState.settings}
            status={status}
            state={translationState}
            targetLanguage={targetLanguage}
            targetLanguageOverride={targetLanguageOverride}
            onTargetLanguageChange={setTargetLanguageOverride}
            openSettings={openSettings}
            openWritingStyles={() => openSettings('writing-styles')}
            onConversationRoutingChange={(mode, direction) =>
              setComposerRouting({ mode, direction })
            }
            dismissedTranslationRequestId={dismissedTranslationRequestId}
            initialConversation={initialConversation}
          />
        ) : (
          <>
            {historyLoading && historyDetail === null && (
              <div className="translate-workspace history-result-workspace" aria-busy="true">
                <div className="nani-result-flow">
                  <article className="nani-result-card">
                    <div className="nani-loading-lines" aria-hidden="true">
                      <span />
                      <span />
                    </div>
                  </article>
                </div>
              </div>
            )}
            {historyError && (
              <p className="inline-error history-result-error" role="alert">
                {historyError}
              </p>
            )}
            {historyDetail && (
              <HistoryTranslationResult
                detail={historyDetail}
                onResumeConversation={(conversation) => {
                  setDismissedTranslationRequestId(
                    translationState.phase === 'selection' ? translationState.requestId : null,
                  );
                  setInitialConversation(conversation);
                  setPage('translate');
                  setSelectedHistoryId(null);
                  setHistoryDetail(null);
                  setHistoryError(null);
                  setComposerRouting({
                    mode: 'conversation',
                    direction: conversation.turns[0]?.direction ?? 'incoming',
                  });
                  setComposerKey((value) => value + 1);
                }}
              />
            )}
          </>
        )}
      </section>
      {settingsRendered && (
        <div
          className={settingsOpen ? 'settings-overlay' : 'settings-overlay closing'}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSettings();
          }}
        >
          <div
            ref={modalRef}
            className={settingsOpen ? 'settings-modal' : 'settings-modal closing'}
            role="dialog"
            aria-modal="true"
            aria-label={t('common.settings')}
          >
            {settingsState.settings ? (
              <SettingsView
                key={settingsTarget}
                settings={settingsState.settings}
                close={closeSettings}
                openWritingStylesOnMount={settingsTarget === 'writing-styles'}
              />
            ) : (
              <p className="main-error">{settingsState.error ?? t('common.loading')}</p>
            )}
          </div>
        </div>
      )}
      {settingsState.settings && !settingsState.settings.onboardingCompleted && (
        <Onboarding
          settings={settingsState.settings}
          logoTargetRef={logoTargetRef}
          onRevealChange={setOnboardingRevealing}
        />
      )}
    </main>
  );
}
