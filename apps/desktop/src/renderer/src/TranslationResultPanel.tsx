import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Copy,
  BadgeAlert,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import type {
  TranslationActionOperation,
  TranslationOperation,
  TranslationSnapshot,
} from '@fumu/translation-core';
import type { FollowUpMessageView, TranslationViewState } from '../../shared/contracts';
import {
  DEFAULT_WRITING_STYLES,
  FIXED_ADJUSTMENT_STYLE_IDS,
  type SettingsSnapshot,
  type WritingStyle,
} from '../../shared/settings-contracts';
import {
  backTranslationAssessmentVisible,
  backTranslationVerdict,
  operationTranslationValue,
  rememberCompletedBackTranslation,
  type StoredBackTranslationResult,
} from './translation-result-state';
import { FumuMascot } from './FumuMascot';
import type { AppliedTranslationInstruction } from '../../shared/applied-translation-instructions-contract';
import { useI18n } from './i18n';
import { operationMessageKeys } from './i18n/catalog';
import {
  localizedWritingStyle,
  localizedWritingStyleName,
  localizedWritingStyles,
} from './i18n/writing-styles';
import { localizedInlineContext } from './i18n/inline-contexts';
import { speechLanguageTag, speechVoiceForLanguage } from './speech-playback';

type AdjustmentOperation = Exclude<TranslationActionOperation, 'alternatives' | 'back-translate'>;
type DisplayAdjustmentOperation = AdjustmentOperation | 'writing-style';

const OPERATION_ICONS: Record<AdjustmentOperation, string> = {
  casual: '😎',
  polite: '🤓',
  shorter: '✊',
  detailed: '🖊️',
  plain: '😶',
  catchy: '🤩',
  natural: '💫',
  humanize: '👻',
};

function isAdjustmentOperation(
  operation: TranslationOperation,
): operation is DisplayAdjustmentOperation {
  return (
    operation !== 'translate' && operation !== 'alternatives' && operation !== 'back-translate'
  );
}

function interactionReady(state: TranslationViewState): boolean {
  return state.phase === 'completed' || (state.phase === 'failed' && state.previousValue !== null);
}

function followUpBusy(messages: readonly FollowUpMessageView[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      (message.phase === 'loading' || message.phase === 'streaming'),
  );
}

function CopyAction({ text }: { readonly text: string }): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setState('idle');
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [text]);

  return (
    <>
      <button
        className="nani-icon-button"
        type="button"
        aria-label={
          state === 'copied'
            ? t('common.copied')
            : state === 'failed'
              ? t('common.copyFailed')
              : t('common.copy')
        }
        onClick={() => {
          void window.fumu
            .copyText(text)
            .then(() => setState('copied'))
            .catch(() => setState('failed'))
            .finally(() => {
              if (timerRef.current !== null) window.clearTimeout(timerRef.current);
              timerRef.current = window.setTimeout(() => setState('idle'), 1_200);
            });
        }}
      >
        {state === 'copied' ? (
          <Check size={18} />
        ) : state === 'failed' ? (
          <BadgeAlert size={18} />
        ) : (
          <Copy size={18} />
        )}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? t('common.copied') : state === 'failed' ? t('common.copyFailed') : ''}
      </span>
    </>
  );
}

async function loadSpeechVoices(
  synthesis: SpeechSynthesis,
): Promise<readonly SpeechSynthesisVoice[]> {
  const currentVoices = synthesis.getVoices();
  if (currentVoices.length > 0) return currentVoices;

  // Chromiumは音声一覧を非同期で読み込むことがある。初回クリックだけ短く待ち、
  // 空配列を即座に「言語なし」と誤判定しないようにする。
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      synthesis.removeEventListener('voiceschanged', finish);
      try {
        resolve(synthesis.getVoices());
      } catch (error) {
        reject(error);
      }
    };
    const timer = window.setTimeout(finish, 800);
    synthesis.addEventListener('voiceschanged', finish);
  });
}

function useSpeechPlayback(): {
  readonly available: boolean;
  readonly speakingId: string | null;
  readonly unavailableLanguage: string | null;
  readonly dismissUnavailableLanguage: () => void;
  readonly toggle: (id: string, text: string, language?: string) => void;
  readonly stop: () => void;
} {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [unavailableLanguage, setUnavailableLanguage] = useState<string | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const requestRef = useRef(0);
  const available =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window;

  useEffect(
    () => () => {
      requestRef.current += 1;
      if (utteranceRef.current === null) return;
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Renderer shutdown must continue even if the OS speech service has already stopped.
      }
    },
    [],
  );

  const toggle = (id: string, text: string, language?: string): void => {
    if (!available) return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    try {
      window.speechSynthesis.cancel();
      if (speakingId === id) {
        utteranceRef.current = null;
        setSpeakingId(null);
        return;
      }
      utteranceRef.current = null;
      setSpeakingId(null);
      void loadSpeechVoices(window.speechSynthesis)
        .then((voices) => {
          if (requestRef.current !== request) return;
          const languageTag = speechLanguageTag(language);
          const voice = languageTag ? speechVoiceForLanguage(voices, languageTag) : null;
          if (languageTag && voice === null) {
            setUnavailableLanguage(language ?? languageTag);
            return;
          }

          const utterance = new SpeechSynthesisUtterance(text);
          if (languageTag) utterance.lang = languageTag;
          if (voice !== null) utterance.voice = voice;
          utterance.onend = () => {
            if (utteranceRef.current !== utterance) return;
            utteranceRef.current = null;
            setSpeakingId(null);
          };
          utterance.onerror = utterance.onend;
          utteranceRef.current = utterance;
          setUnavailableLanguage(null);
          setSpeakingId(id);
          window.speechSynthesis.speak(utterance);
        })
        .catch(() => {
          if (requestRef.current !== request) return;
          utteranceRef.current = null;
          setSpeakingId(null);
        });
    } catch {
      // OS側に利用可能な音声がない場合も翻訳結果の他の操作は継続できるよう、
      // 読み上げ状態だけを解除して例外をUI境界の外へ漏らさない。
      utteranceRef.current = null;
      setSpeakingId(null);
    }
  };

  const stop = useCallback((): void => {
    if (!available) return;
    requestRef.current += 1;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // A failed cancellation is reflected by clearing our local playback state.
    }
    utteranceRef.current = null;
    setSpeakingId(null);
  }, [available]);

  const dismissUnavailableLanguage = useCallback((): void => {
    setUnavailableLanguage(null);
  }, []);

  useEffect(() => {
    if (unavailableLanguage === null) return;
    const timer = window.setTimeout(dismissUnavailableLanguage, 8_000);
    return () => window.clearTimeout(timer);
  }, [dismissUnavailableLanguage, unavailableLanguage]);

  return {
    available,
    speakingId,
    unavailableLanguage,
    dismissUnavailableLanguage,
    toggle,
    stop,
  };
}

function useWritingStyles(): readonly WritingStyle[] {
  const [styles, setStyles] = useState<readonly WritingStyle[]>([]);
  useEffect(() => {
    let active = true;
    void window.fumu
      .getSettings()
      .then((settings: SettingsSnapshot) => {
        if (active) setStyles(settings.writingStyles);
      })
      .catch(() => undefined);
    const unsubscribe = window.fumu.onSettingsChanged((settings) =>
      setStyles(settings.writingStyles),
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return styles;
}

function AdjustmentMenu({
  disabled,
  onApplyAction,
  onApplyWritingStyle,
}: {
  readonly disabled: boolean;
  readonly onApplyAction: (operation: AdjustmentOperation) => void;
  readonly onApplyWritingStyle: (styleId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const writingStyles = localizedWritingStyles(useWritingStyles(), t);
  const visibleStyles = writingStyles.filter(
    (style) =>
      style.hidden !== true &&
      style.deleted !== true &&
      !FIXED_ADJUSTMENT_STYLE_IDS.includes(style.id as (typeof FIXED_ADJUSTMENT_STYLE_IDS)[number]),
  );
  const fixedAdjustments = [
    { operation: 'shorter' as const, style: localizedWritingStyle(DEFAULT_WRITING_STYLES[0], t) },
    { operation: 'detailed' as const, style: localizedWritingStyle(DEFAULT_WRITING_STYLES[1], t) },
  ];
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const closeMenu = (): void => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    setOpen(false);
    closeTimerRef.current = window.setTimeout(() => {
      setRendered(false);
      closeTimerRef.current = null;
    }, 140);
  };
  const showMenu = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setRendered(true);
    setOpen(true);
  };

  useEffect(() => {
    if (!rendered) return;
    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target) || menuRef.current?.contains(event.target))
        return;
      closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu();
    };
    const closeOnViewportChange = (): void => closeMenu();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [rendered]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = rootRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (trigger === undefined || menu === null) return;

    // 項目数から高さを推測すると、実寸との差だけ上側に余計な空白が生まれる。
    // PortalをDOMへ置いた直後に測り、上下どちらに開いてもトリガーとの距離を揃える。
    const viewportPadding = 12;
    const triggerGap = 9;
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const preferredTop = trigger.bottom + triggerGap;
    const top =
      preferredTop + menuHeight <= window.innerHeight - viewportPadding
        ? preferredTop
        : Math.max(viewportPadding, trigger.top - menuHeight - triggerGap);
    const left = Math.min(
      window.innerWidth - menuWidth - viewportPadding,
      Math.max(viewportPadding, trigger.right - menuWidth),
    );
    setPosition({ top, left });
  }, [open, visibleStyles.length]);

  const applyWritingStyle = (styleId: string): void => {
    closeMenu();
    onApplyWritingStyle(styleId);
  };

  const toggle = (): void => {
    if (open) {
      closeMenu();
      return;
    }
    showMenu();
  };

  return (
    <div className="adjustment-control" ref={rootRef}>
      <button
        className="adjustment-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        {t('result.adjust')} <ChevronDown size={14} />
      </button>
      {rendered &&
        createPortal(
          <div
            ref={menuRef}
            className={open ? 'adjustment-menu' : 'adjustment-menu adjustment-menu-closing'}
            role="menu"
            aria-label={t('result.adjustAria')}
            style={position}
          >
            <div className="adjustment-menu-pair" role="group">
              {fixedAdjustments.map((item) => (
                <button
                  type="button"
                  role="menuitem"
                  key={item.operation}
                  onClick={() => {
                    closeMenu();
                    onApplyAction(item.operation);
                  }}
                >
                  <span aria-hidden="true">{item.style.icon ?? '✨'}</span>
                  {item.style.name}
                </button>
              ))}
            </div>
            {Array.from({ length: Math.ceil(visibleStyles.length / 2) }, (_, rowIndex) => {
              const row = visibleStyles.slice(rowIndex * 2, rowIndex * 2 + 2);
              return (
                <div className="adjustment-menu-pair" role="group" key={rowIndex}>
                  {row.map((style) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={style.id}
                      onClick={() => applyWritingStyle(style.id)}
                    >
                      <span aria-hidden="true">{style.icon ?? '✨'}</span>
                      {style.name}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

function ResultToolbar({
  id,
  text,
  language,
  interactive,
  disabled,
  backCheckActive = false,
  speechAvailable,
  speaking,
  onToggleSpeech,
  onApplyAction,
  onApplyWritingStyle,
}: {
  readonly id: string;
  readonly text: string;
  readonly language?: string | undefined;
  readonly interactive: boolean;
  readonly disabled: boolean;
  readonly backCheckActive?: boolean;
  readonly speechAvailable: boolean;
  readonly speaking: boolean;
  readonly onToggleSpeech: (id: string, text: string, language?: string) => void;
  readonly onApplyAction: (
    action: Exclude<TranslationActionOperation, 'alternatives'>,
    baseTranslation: string,
  ) => void;
  readonly onApplyWritingStyle: (styleId: string, baseTranslation: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="result-toolbar">
      <div className="result-toolbar-icons">
        <CopyAction text={text} />
        <button
          className="nani-icon-button"
          type="button"
          aria-label={speaking ? t('result.stopReading') : t('result.readAloud')}
          aria-pressed={speaking}
          disabled={!speechAvailable}
          onClick={() => onToggleSpeech(id, text, language)}
        >
          {speaking ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      </div>
      {interactive && (
        <div className="result-actions">
          <AdjustmentMenu
            disabled={disabled}
            onApplyAction={(action) => onApplyAction(action, text)}
            onApplyWritingStyle={(styleId) => onApplyWritingStyle(styleId, text)}
          />
          <button
            className="back-translate-action"
            type="button"
            disabled={disabled || backCheckActive}
            onClick={() => onApplyAction('back-translate', text)}
          >
            <RotateCcw size={15} />
            {t('result.backTranslateCheck')}
          </button>
        </div>
      )}
    </div>
  );
}

function explanationItems(explanation: string | undefined): readonly string[] {
  return (explanation ?? '')
    .split(/\r?\n/u)
    .map((item) => item.replace(/^\s*[-*•・]\s*/u, '').trim())
    .filter(Boolean)
    .slice(0, 4);
}

function Notes({
  explanation,
  nuance,
}: {
  readonly explanation?: string | undefined;
  readonly nuance?: string | undefined;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const items = [...explanationItems(explanation), ...(nuance ? [nuance] : [])];
  if (items.length === 0) return null;
  return (
    <ul className="nani-notes" aria-label={t('result.nuances')}>
      {items.map((item, index) => (
        <li key={String(index) + '-' + item}>{item}</li>
      ))}
    </ul>
  );
}

function TranslationCard({
  id,
  value,
  label,
  interactive,
  controlsDisabled,
  pending,
  backCheckActive = false,
  detail,
  speechAvailable,
  speakingId,
  onToggleSpeech,
  onApplyAction,
  onApplyWritingStyle,
}: {
  readonly id: string;
  readonly value: TranslationSnapshot | null;
  readonly label?: { readonly icon: string; readonly text: string } | undefined;
  readonly interactive: boolean;
  readonly controlsDisabled: boolean;
  readonly pending: boolean;
  readonly backCheckActive?: boolean;
  readonly detail?: ReactNode;
  readonly speechAvailable: boolean;
  readonly speakingId: string | null;
  readonly onToggleSpeech: (id: string, text: string, language?: string) => void;
  readonly onApplyAction: (
    action: Exclude<TranslationActionOperation, 'alternatives'>,
    baseTranslation: string,
  ) => void;
  readonly onApplyWritingStyle: (styleId: string, baseTranslation: string) => void;
}): React.JSX.Element {
  return (
    <article
      className="nani-result-card"
      aria-busy={pending}
      data-testid="translation-card"
      data-state={pending ? 'pending' : value?.translation ? 'complete' : 'empty'}
    >
      {label && (
        <span className="translation-variant-label">
          <span aria-hidden="true">{label.icon}</span>
          {label.text}
        </span>
      )}
      {value?.translation ? (
        <p className="nani-translation-text">{value.translation}</p>
      ) : pending ? (
        <div className="nani-loading-lines" aria-hidden="true">
          <span />
          <span />
        </div>
      ) : null}
      {value?.translation && (
        <ResultToolbar
          id={id}
          text={value.translation}
          language={value.targetLanguage}
          interactive={interactive}
          disabled={controlsDisabled}
          backCheckActive={backCheckActive}
          speechAvailable={speechAvailable}
          speaking={speakingId === id}
          onToggleSpeech={onToggleSpeech}
          onApplyAction={onApplyAction}
          onApplyWritingStyle={onApplyWritingStyle}
        />
      )}
      {detail}
      <Notes explanation={value?.explanation} />
    </article>
  );
}

function BackTranslationCheck({
  value,
  pending,
  assessmentVisible,
}: {
  readonly value: TranslationSnapshot | null;
  readonly pending: boolean;
  readonly assessmentVisible: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const naturalness = value?.isNatural;
  const verdict = backTranslationVerdict(naturalness, {
    positive: t('result.natural'),
    negative: t('result.unnatural'),
    unknown: t('result.naturalUnknown'),
  });
  const meaningVerdict = backTranslationVerdict(value?.meaningPreserved, {
    positive: t('result.meaningPreserved'),
    negative: t('result.meaningChanged'),
    unknown: t('result.meaningUnknown'),
  });
  return (
    <div className="back-translation-check" aria-busy={pending}>
      {value?.translation ? (
        <>
          <div className="back-translation-heading">
            <span>{t('result.backTranslate')}</span>
            <strong>{value.translation}</strong>
          </div>
          {assessmentVisible && (
            <>
              <div className={'back-translation-verdict ' + verdict.tone}>
                {naturalness === false ? (
                  <X size={18} />
                ) : naturalness === true ? (
                  <Check size={18} />
                ) : (
                  <span aria-hidden="true">?</span>
                )}
                <strong>{verdict.label}</strong>
              </div>
              <div className={'back-translation-verdict ' + meaningVerdict.tone}>
                {value?.meaningPreserved === false ? (
                  <X size={18} />
                ) : value?.meaningPreserved === true ? (
                  <Check size={18} />
                ) : (
                  <span aria-hidden="true">?</span>
                )}
                <strong>{meaningVerdict.label}</strong>
              </div>
              <Notes explanation={value.explanation} />
            </>
          )}
        </>
      ) : (
        <div className="nani-loading-lines back-translation-loading" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}

function FollowUpMessages({ messages }: { readonly messages: readonly FollowUpMessageView[] }) {
  const { t } = useI18n();
  return messages.map((message) => (
    <article className={'nani-follow-up ' + message.role} key={message.id}>
      {message.role === 'user' ? (
        message.text
      ) : message.phase === 'failed' ? (
        <span className="nani-follow-up-error">{t('result.followUpError')}</span>
      ) : (
        message.text || t('result.responding')
      )}
    </article>
  ));
}

export function TranslationResultPanel({
  sourceText,
  translation,
  followUpMessages,
  appliedInstructions = [],
  interactive = true,
  compact = false,
  showFollowUpForm = interactive,
}: {
  readonly sourceText: string;
  readonly translation: TranslationViewState;
  readonly followUpMessages: readonly FollowUpMessageView[];
  readonly appliedInstructions?: readonly AppliedTranslationInstruction[];
  readonly interactive?: boolean;
  readonly compact?: boolean;
  readonly showFollowUpForm?: boolean;
}): React.JSX.Element {
  const { locale, t, formatLanguageName } = useI18n();
  const operationValue = operationTranslationValue(translation);
  const ready = interactionReady(translation);
  const pending = translation.phase === 'loading' || translation.phase === 'streaming';
  const busy = followUpBusy(followUpMessages);
  const [question, setQuestion] = useState('');
  const [backTranslationResults, setBackTranslationResults] = useState<
    ReadonlyMap<string, StoredBackTranslationResult>
  >(new Map());
  const speech = useSpeechPlayback();
  const isBackTranslation =
    translation.operation === 'back-translate' && translation.cards.length > 0;
  const activeBackTranslationText = isBackTranslation
    ? (translation.previousValue?.translation ?? null)
    : null;
  const assessmentVisible = backTranslationAssessmentVisible(translation);
  useEffect(() => {
    speech.stop();
    speech.dismissUnavailableLanguage();
    setBackTranslationResults(new Map());
    // A new source starts a separate interaction; speech and target selection must not leak into it.
  }, [sourceText, speech.dismissUnavailableLanguage, speech.stop]);
  useEffect(() => {
    if (translation.operation !== 'back-translate' || translation.phase !== 'completed') return;
    setBackTranslationResults((current) => rememberCompletedBackTranslation(current, translation));
  }, [translation]);
  const isAdjustment = isAdjustmentOperation(translation.operation);
  const originalTranslation =
    translation.cards.find((card) => card.operation === 'translate')?.value ??
    (translation.operation === 'translate' ? operationValue : null);
  const alternatives =
    originalTranslation?.alternativesNeeded === true
      ? (originalTranslation.alternatives ?? []).filter((alternative) =>
          Boolean(alternative.text?.trim()),
        )
      : [];
  const applyAction = (
    action: Exclude<TranslationActionOperation, 'alternatives'>,
    baseTranslation: string,
  ): void => {
    void window.fumu.applyTranslationAction(action, baseTranslation).catch(() => undefined);
  };
  const applyWritingStyle = (styleId: string, baseTranslation: string): void => {
    void window.fumu.applyWritingStyle(styleId, baseTranslation).catch(() => undefined);
  };
  const backTranslationFor = (
    baseTranslation: string,
  ):
    | {
        readonly value: TranslationSnapshot | null;
        readonly pending: boolean;
        readonly assessmentVisible: boolean;
      }
    | undefined => {
    if (
      activeBackTranslationText === baseTranslation &&
      (pending || Boolean(operationValue?.translation))
    ) {
      return { value: operationValue, pending, assessmentVisible };
    }
    const stored = backTranslationResults.get(baseTranslation);
    return stored === undefined ? undefined : { ...stored, pending: false };
  };
  const operationMeta = isAdjustment
    ? translation.operation === 'writing-style'
      ? {
          label:
            translation.writingStyleName === undefined
              ? t('result.style')
              : localizedWritingStyleName(translation.writingStyleName, t),
          icon: '✨',
        }
      : {
          label: t(operationMessageKeys[translation.operation]),
          icon: OPERATION_ICONS[translation.operation],
        }
    : null;
  const lastCompletedCard = translation.cards.at(-1) ?? null;
  const directionValue = lastCompletedCard?.value ?? operationValue;
  const statusText =
    translation.phase === 'failed'
      ? t('result.failed')
      : isBackTranslation
        ? t('result.completed')
        : pending
          ? isAdjustment
            ? t('result.adjusting')
            : t('result.translating')
          : alternatives.length > 0
            ? t('result.alternativeCount', { count: alternatives.length + 1 })
            : isAdjustment
              ? t('result.adjusted', { style: operationMeta?.label ?? t('result.style') })
              : isBackTranslation
                ? t('result.backTranslated')
                : t('result.completed');

  return (
    <section
      className={compact ? 'nani-result-flow compact' : 'nani-result-flow'}
      aria-live="polite"
    >
      {speech.unavailableLanguage !== null && (
        <aside className="speech-voice-notice" role="alert">
          <BadgeAlert size={22} aria-hidden="true" />
          <div>
            <p>
              {t('result.voiceUnavailable', {
                language: formatLanguageName(speech.unavailableLanguage),
              })}
            </p>
            <div className="speech-voice-notice-actions">
              <button
                type="button"
                onClick={() => void window.fumu.restartApp().catch(() => undefined)}
              >
                {t('result.restartApp')}
              </button>
              <button
                type="button"
                onClick={() => void window.fumu.openLanguageSettings().catch(() => undefined)}
              >
                {t('result.openLanguageSettings')}
              </button>
            </div>
          </div>
          <button
            className="speech-voice-notice-close"
            type="button"
            aria-label={t('result.dismissVoiceNotice')}
            onClick={speech.dismissUnavailableLanguage}
          >
            <X size={17} />
          </button>
        </aside>
      )}
      <article className="nani-source-card">
        {appliedInstructions.length > 0 && (
          <ul className="result-instruction-list" aria-label={t('result.instructions')}>
            {appliedInstructions.map((instruction, index) => (
              <li
                className={'result-instruction-chip ' + instruction.kind}
                key={`${instruction.kind}-${String(index)}`}
                title={
                  instruction.kind === 'context'
                    ? localizedInlineContext(instruction.label, locale)
                    : localizedWritingStyleName(instruction.label, t)
                }
              >
                {instruction.kind === 'context' ? (
                  <AtSign size={13} aria-hidden="true" />
                ) : (
                  <Sparkles size={13} aria-hidden="true" />
                )}
                <span>
                  {instruction.kind === 'context'
                    ? localizedInlineContext(instruction.label, locale)
                    : localizedWritingStyleName(instruction.label, t)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p>{sourceText}</p>
        <div className="nani-source-meta">
          <span>
            {directionValue?.sourceLanguage
              ? formatLanguageName(directionValue.sourceLanguage)
              : t('result.detectingLanguage')}
          </span>
          <span>→</span>
          <span>
            {directionValue?.targetLanguage
              ? formatLanguageName(directionValue.targetLanguage)
              : t('result.targetLanguage')}
          </span>
          <CopyAction text={sourceText} />
        </div>
      </article>

      <div className="translation-arrived">
        <span className="mini-brand">
          <FumuMascot animated={pending} />
        </span>
        <span>{statusText}</span>
      </div>

      {translation.cards.length === 0 && translation.operation === 'translate' && (
        <TranslationCard
          id="primary"
          value={operationValue}
          interactive={interactive}
          controlsDisabled={!ready || busy || pending}
          pending={pending}
          speechAvailable={speech.available}
          speakingId={speech.speakingId}
          onToggleSpeech={speech.toggle}
          onApplyAction={applyAction}
          onApplyWritingStyle={applyWritingStyle}
        />
      )}

      {translation.cards.map((card, index) => {
        const isLast = index === translation.cards.length - 1;
        const backTranslation = backTranslationFor(card.value.translation);
        const meta =
          card.operation === 'translate' || card.operation === 'alternatives'
            ? null
            : card.operation === 'writing-style'
              ? {
                  label:
                    card.writingStyleName === undefined
                      ? t('result.style')
                      : localizedWritingStyleName(card.writingStyleName, t),
                  icon: '✨',
                }
              : {
                  label: t(operationMessageKeys[card.operation]),
                  icon: OPERATION_ICONS[card.operation],
                };
        return (
          <TranslationCard
            key={String(index) + '-' + card.operation}
            id={`card-${String(index)}`}
            value={card.value}
            label={meta === null ? undefined : { icon: meta.icon, text: meta.label }}
            interactive={interactive && isLast}
            controlsDisabled={!ready || busy || pending || !isLast}
            pending={false}
            backCheckActive={activeBackTranslationText === card.value.translation}
            detail={
              backTranslation !== undefined &&
              (backTranslation.pending || Boolean(backTranslation.value?.translation)) ? (
                <BackTranslationCheck
                  value={backTranslation.value}
                  pending={backTranslation.pending}
                  assessmentVisible={backTranslation.assessmentVisible}
                />
              ) : undefined
            }
            speechAvailable={speech.available}
            speakingId={speech.speakingId}
            onToggleSpeech={speech.toggle}
            onApplyAction={applyAction}
            onApplyWritingStyle={applyWritingStyle}
          />
        );
      })}

      {isAdjustment &&
        translation.phase !== 'completed' &&
        (pending || Boolean(operationValue?.translation)) && (
          <TranslationCard
            id="pending-adjustment"
            value={operationValue}
            label={
              operationMeta === null
                ? undefined
                : { icon: operationMeta.icon, text: operationMeta.label }
            }
            interactive={interactive}
            controlsDisabled={!ready || busy}
            pending={pending}
            speechAvailable={speech.available}
            speakingId={speech.speakingId}
            onToggleSpeech={speech.toggle}
            onApplyAction={applyAction}
            onApplyWritingStyle={applyWritingStyle}
          />
        )}

      {alternatives.map((alternative, index) => {
        const alternativeText = alternative.text ?? '';
        const backTranslation = backTranslationFor(alternativeText);
        return (
          <article className="nani-result-card translation-alternative-card" key={index}>
            <span className="translation-variant-label">
              {t('result.alternative', { index: index + 1 })}
            </span>
            <p className="nani-translation-text">{alternative.text}</p>
            <ResultToolbar
              id={`alternative-${String(index)}`}
              text={alternativeText}
              language={originalTranslation?.targetLanguage}
              interactive={interactive}
              disabled={!ready || busy || pending}
              backCheckActive={activeBackTranslationText === alternativeText}
              speechAvailable={speech.available}
              speaking={speech.speakingId === `alternative-${String(index)}`}
              onToggleSpeech={speech.toggle}
              onApplyAction={applyAction}
              onApplyWritingStyle={applyWritingStyle}
            />
            {backTranslation !== undefined &&
              (backTranslation.pending || Boolean(backTranslation.value?.translation)) && (
                <BackTranslationCheck
                  value={backTranslation.value}
                  pending={backTranslation.pending}
                  assessmentVisible={backTranslation.assessmentVisible}
                />
              )}
            <Notes nuance={alternative.nuance} />
          </article>
        );
      })}

      {translation.phase === 'failed' && (
        <>
          <div className="nani-error" role="alert">
            <span>{t('result.failed')}</span>
            {translation.retryable && interactive && (
              <button type="button" onClick={() => void window.fumu.retryTranslation()}>
                <RefreshCw size={14} />
                {t('common.retry')}
              </button>
            )}
          </div>
          {translation.debugResponse && (
            <details className="nani-debug-response">
              <summary>{t('result.providerResponse')}</summary>
              <pre>{translation.debugResponse}</pre>
            </details>
          )}
        </>
      )}

      <FollowUpMessages messages={followUpMessages} />

      {interactive && showFollowUpForm && (
        <form
          className="nani-question"
          onSubmit={(event) => {
            event.preventDefault();
            const content = question.trim();
            if (!content || !ready || busy) return;
            setQuestion('');
            void window.fumu.sendFollowUp(content);
          }}
        >
          <input
            aria-label={t('result.ask')}
            value={question}
            maxLength={5_000}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            placeholder={t('result.askPlaceholder')}
            disabled={!ready || busy}
          />
          <button
            type="submit"
            aria-label={t('result.sendQuestion')}
            disabled={!ready || busy || !question.trim()}
          >
            <ArrowUp size={17} />
          </button>
        </form>
      )}
    </section>
  );
}
