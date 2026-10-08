import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  ArrowLeftRight,
  History as HistoryIcon,
  Image as ImageIcon,
  MessagesSquare,
  PenLine,
  ScanText,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { MAX_TRANSLATION_SOURCE_CODE_POINTS } from '@fumu/translation-core';
import type { DesktopStatus, ImageInputPayload, PopupViewState } from '../../../shared/contracts';
import type { HistoryDetail, HistoryListItem } from '../../../shared/history-contracts';
import {
  DEFAULT_TRANSLATE_SHORTCUT,
  FIXED_ADJUSTMENT_STYLE_IDS,
  MAX_WRITING_STYLE_INSTRUCTION_LENGTH,
  MAX_WRITING_STYLE_NAME_LENGTH,
  NATIVE_LANGUAGE_OPTIONS,
  type NativeLanguage,
  type SettingsSnapshot,
  type WritingStyle,
} from '../../../shared/settings-contracts';
import { TranslationResultPanel as SharedTranslationResultPanel } from '../TranslationResultPanel';
import { FumuMascot } from '../FumuMascot';
import { IdleMascot } from '../IdleMascot';
import { Onboarding } from '../Onboarding';
import { SettingsView, SoftSelect } from './SettingsView';
import {
  appliedTranslationInstructions,
  type AppliedTranslationInstruction,
} from './applied-translation-instructions';
import { InlineContextEditor, type InlineContextEditorHandle } from './InlineContextEditor';
import { composeWritingStyleInstruction } from './writing-style-selection';
import { useI18n } from '../i18n';
import { localizedWritingStyles } from '../i18n/writing-styles';
import { displayedTargetLanguage } from './language-target';
import { shouldOpenExternalTranslation } from './external-translation-state';
import { displayAccelerator } from './shortcut-display';
import { ConversationTranslationFlow, ConversationTurnResult } from './ConversationTranslationFlow';
import { AnotherTextBar, type AnotherTextSubmission } from './AnotherTextBar';
import { QuickSettingsControl } from './QuickSettingsControl';
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
  screenshotHotkeyState: 'disabled',
  selectionServiceRunning: false,
  popupVisible: false,
  activeProviderName: null,
  activeModelName: null,
  translationConfigured: false,
};
const INITIAL_POPUP: PopupViewState = { phase: 'idle', requestId: null };
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_SIDEBAR_WIDTH = 276;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 420;
// 全件を一度に読み込まず、履歴モーダルから必要な分だけ追加取得する。
const HISTORY_PAGE_SIZE = 30;
// 表示上の好みだけを保持し、同期対象になるアプリ設定スキーマには含めない。
const SIDEBAR_WIDTH_STORAGE_KEY = 'fumu.main.sidebarWidth';

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

class ImageInputTooLargeError extends Error {}

async function imagePayloadFromFile(file: File): Promise<ImageInputPayload> {
  if (file.size > MAX_IMAGE_INPUT_BYTES) throw new ImageInputTooLargeError();
  const mediaType = file.type.toLowerCase();
  if (mediaType === 'image/png' || mediaType === 'image/jpeg') {
    return { mediaType, data: new Uint8Array(await file.arrayBuffer()) };
  }

  // main側の縮小処理を一元化するため、rendererでは形式だけをPNGへ揃える。
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas is unavailable');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value === null) reject(new Error('PNG conversion failed'));
        else resolve(value);
      }, 'image/png');
    });
    if (blob.size > MAX_IMAGE_INPUT_BYTES) throw new ImageInputTooLargeError();
    return { mediaType: 'image/png', data: new Uint8Array(await blob.arrayBuffer()) };
  } finally {
    bitmap.close();
  }
}

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
        .listHistory({ query: '', limit: HISTORY_PAGE_SIZE })
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

const TARGET_LANGUAGE_FLAGS: Record<NativeLanguage, string> = {
  Japanese: '🇯🇵',
  English: '🇺🇸',
  Korean: '🇰🇷',
  'Chinese (Simplified)': '🇨🇳',
  'Chinese (Traditional)': '🇹🇼',
  Spanish: '🇪🇸',
  French: '🇫🇷',
  German: '🇩🇪',
  Arabic: '🇸🇦',
  Bengali: '🇧🇩',
  Czech: '🇨🇿',
  Danish: '🇩🇰',
  Dutch: '🇳🇱',
  Finnish: '🇫🇮',
  Greek: '🇬🇷',
  Hebrew: '🇮🇱',
  Hindi: '🇮🇳',
  Hungarian: '🇭🇺',
  Indonesian: '🇮🇩',
  Italian: '🇮🇹',
  Malay: '🇲🇾',
  Norwegian: '🇳🇴',
  Persian: '🇮🇷',
  Polish: '🇵🇱',
  'Portuguese (Brazil)': '🇧🇷',
  'Portuguese (Portugal)': '🇵🇹',
  Romanian: '🇷🇴',
  Russian: '🇷🇺',
  Swedish: '🇸🇪',
  Thai: '🇹🇭',
  Turkish: '🇹🇷',
  Ukrainian: '🇺🇦',
  Urdu: '🇵🇰',
  Vietnamese: '🇻🇳',
};

function TargetLanguageSelect({
  value,
  onChange,
  className,
  compact = false,
}: {
  readonly value: NativeLanguage;
  readonly onChange: (value: NativeLanguage) => void;
  readonly className: string;
  readonly compact?: boolean;
}): React.JSX.Element {
  const { t, formatLanguageName } = useI18n();
  const targetLanguageOptions = useMemo(
    () =>
      NATIVE_LANGUAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: (
          <>
            <span className="language-option-flag" aria-hidden="true">
              {TARGET_LANGUAGE_FLAGS[option.value]}
            </span>
            <span>{formatLanguageName(option.value)}</span>
          </>
        ),
      })),
    [formatLanguageName],
  );
  const selectedLabel = compact ? (
    <span aria-hidden="true">{TARGET_LANGUAGE_FLAGS[value]}</span>
  ) : (
    <>
      <span className="language-chip-flag" aria-hidden="true">
        {TARGET_LANGUAGE_FLAGS[value]}
      </span>
      <span className="language-chip-name">{formatLanguageName(value)}</span>
    </>
  );
  return (
    <div className={className}>
      <SoftSelect
        label={t('main.targetLanguage')}
        value={value}
        options={targetLanguageOptions}
        selectedLabel={selectedLabel}
        selectedPrefix={<ArrowLeftRight size={14} aria-hidden="true" />}
        menuPlacement={compact ? 'right' : 'below'}
        onChange={onChange}
      />
    </div>
  );
}

function ScreenCaptureButton({
  disabled,
  onClick,
  showTooltip = false,
}: {
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly showTooltip?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <button
      className="sidebar-capture"
      type="button"
      aria-label={t('main.translateScreen')}
      title={showTooltip ? undefined : t('main.translateScreen')}
      disabled={disabled}
      onClick={onClick}
    >
      <ScanText size={19} aria-hidden="true" />
    </button>
  );
}

function MiniRail({
  targetLanguage,
  showTargetLanguage,
  onTargetLanguageChange,
  historyItems,
  selectedHistoryId,
  onHome,
  onCapture,
  capturePending,
  captureShortcut,
  onHistorySelect,
  onShowAllHistory,
  allHistoryButtonRef,
  onOpenSettings,
  inert,
}: {
  readonly targetLanguage: NativeLanguage;
  readonly showTargetLanguage: boolean;
  readonly onTargetLanguageChange: (value: NativeLanguage) => void;
  readonly historyItems: readonly HistoryListItem[];
  readonly selectedHistoryId: string | null;
  readonly onHome: () => void;
  readonly onCapture: () => void;
  readonly capturePending: boolean;
  readonly captureShortcut?: string;
  readonly onHistorySelect: (id: string) => void;
  readonly onShowAllHistory: () => void;
  readonly allHistoryButtonRef: React.RefObject<HTMLButtonElement | null>;
  readonly onOpenSettings: () => void;
  readonly inert: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    if (!historyOpen) return;
    const closeOutside = (event: MouseEvent): void => {
      if (!railRef.current?.contains(event.target as Node)) setHistoryOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setHistoryOpen(false);
      window.requestAnimationFrame(() => historyButtonRef.current?.focus());
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [historyOpen]);

  return (
    <div ref={railRef} className="mini-rail" inert={inert}>
      <div className="mini-rail-primary">
        {showTargetLanguage && (
          <div className="mini-rail-tool">
            <TargetLanguageSelect
              className="mini-rail-language"
              compact
              value={targetLanguage}
              onChange={onTargetLanguageChange}
            />
            <MiniRailTooltip label={t('main.translateLanguage')} />
          </div>
        )}
        <div className="mini-rail-tool">
          <button
            className="mini-rail-button"
            type="button"
            aria-label={t('main.newTranslation')}
            onClick={onHome}
          >
            <PenLine size={19} aria-hidden="true" />
          </button>
          <MiniRailTooltip label={t('main.newTranslation')} />
        </div>
        <div className="mini-rail-tool">
          <ScreenCaptureButton disabled={capturePending} onClick={onCapture} showTooltip />
          <MiniRailTooltip
            label={t('main.translateScreen')}
            {...(captureShortcut === undefined ? {} : { shortcut: captureShortcut })}
          />
        </div>
        <div className="mini-rail-history mini-rail-tool" data-open={historyOpen || undefined}>
          <button
            ref={(element) => {
              historyButtonRef.current = element;
              allHistoryButtonRef.current = element;
            }}
            className="mini-rail-button"
            type="button"
            aria-label={t('main.history')}
            aria-haspopup="dialog"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((current) => !current)}
          >
            <HistoryIcon size={19} aria-hidden="true" />
          </button>
          <MiniRailTooltip label={t('main.history')} />
          {historyOpen && (
            <div className="mini-rail-history-popover" role="dialog" aria-label={t('main.history')}>
              <div className="mini-rail-history-items">
                {historyItems.slice(0, 6).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={selectedHistoryId === item.id ? 'selected' : undefined}
                    aria-current={selectedHistoryId === item.id ? 'page' : undefined}
                    title={item.sourceText}
                    onClick={() => {
                      setHistoryOpen(false);
                      onHistorySelect(item.id);
                      // 押した行はポップオーバーごと消えるため、キーボード操作の起点を履歴ボタンへ戻す。
                      window.requestAnimationFrame(() => historyButtonRef.current?.focus());
                    }}
                  >
                    {item.sourceText}
                  </button>
                ))}
                {historyItems.length === 0 && <p>{t('history.empty')}</p>}
              </div>
              <button
                className="mini-rail-show-all"
                type="button"
                onClick={() => {
                  setHistoryOpen(false);
                  onShowAllHistory();
                }}
              >
                {t('main.showAllHistory')}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="mini-rail-footer">
        <div className="mini-rail-tool">
          <button
            className="sidebar-settings"
            type="button"
            aria-label={t('main.openSettings')}
            onClick={onOpenSettings}
          >
            <SettingsIcon size={19} aria-hidden="true" />
          </button>
          <MiniRailTooltip label={t('main.openSettings')} />
        </div>
      </div>
    </div>
  );
}

function MiniRailTooltip({
  label,
  shortcut,
}: {
  readonly label: string;
  readonly shortcut?: string;
}): React.JSX.Element {
  return (
    <span className="mini-rail-tooltip" aria-hidden="true">
      <span>{label}</span>
      {shortcut !== undefined && <kbd>{shortcut}</kbd>}
    </span>
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
  pendingImage,
  onPendingImageConsumed,
  pendingSubmission,
  onPendingSubmissionConsumed,
  focusInputRequestId,
  onInputFocusRequestHandled,
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
  /** 入力欄以外（どの画面でも）に貼り付け・ドロップされた画像。受け取ったら一度だけ読み取る。 */
  pendingImage: { readonly id: number; readonly file: File } | null;
  onPendingImageConsumed(): void;
  pendingSubmission: { readonly id: number; readonly submission: AnotherTextSubmission } | null;
  onPendingSubmissionConsumed(): void;
  focusInputRequestId: string | null;
  onInputFocusRequestHandled(requestId: string): void;
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
  const [text, setText] = useState(() => pendingSubmission?.submission.text ?? '');
  const [inlineContexts, setInlineContexts] = useState<readonly string[]>(
    () => pendingSubmission?.submission.inlineContexts ?? [],
  );
  const [resultInstructions, setResultInstructions] = useState<
    readonly AppliedTranslationInstruction[]
  >([]);
  const [styleAdjustEnabled, setStyleAdjustEnabled] = useState(
    () => (pendingSubmission?.submission.writingStyleIds.length ?? 0) > 0,
  );
  const [styleAdjustRendered, setStyleAdjustRendered] = useState(
    () => (pendingSubmission?.submission.writingStyleIds.length ?? 0) > 0,
  );
  const [selectedWritingStyleIds, setSelectedWritingStyleIds] = useState<readonly string[]>(
    () => pendingSubmission?.submission.writingStyleIds ?? [],
  );
  const [additionalInstructionOpen, setAdditionalInstructionOpen] = useState(false);
  const [additionalInstruction, setAdditionalInstruction] = useState('');
  const [saveStyleOpen, setSaveStyleOpen] = useState(false);
  const [saveStyleName, setSaveStyleName] = useState('');
  const [styleSaveError, setStyleSaveError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(initialConversation === null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 画像を受け取った時点で入力画面から結果画面へ切り替え、読み取り→翻訳の進行を見せる。
  // 'translating'は書き起こし文を送信してから、mainが翻訳状態を返すまでの短い間を埋めるための段階。
  const [imageStage, setImageStage] = useState<
    | { readonly previewUrl: string; readonly phase: 'reading' }
    | { readonly previewUrl: string; readonly phase: 'translating'; readonly text: string }
    | {
        readonly previewUrl: string;
        readonly phase: 'error';
        readonly message: string;
        readonly action:
          { readonly type: 'model'; readonly file: File } | { readonly type: 'settings' } | null;
      }
    | null
  >(null);
  // 結果画面の原文カードに出す元画像。原文を直して翻訳し直しても同じ画像の翻訳として表示を保つため、
  // その画像から翻訳した原文の一覧と組にして持ち、別の翻訳結果には画像を出さない。
  const [resultImage, setResultImage] = useState<{
    readonly url: string;
    readonly sourceTexts: readonly string[];
  } | null>(null);
  const styleAdjustCloseTimerRef = useRef<number | null>(null);
  const submittingRef = useRef(false);
  const submissionEpochRef = useRef(0);
  const editorRef = useRef<InlineContextEditorHandle>(null);
  const imageRequestIdRef = useRef(0);
  const imagePreviewUrlRef = useRef<string | null>(null);
  const resultImageUrlRef = useRef<string | null>(null);
  const imageExtractionActiveRef = useRef(false);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
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
  const submit = (submission?: {
    readonly text: string;
    readonly direction?: ConversationDirection;
    readonly inlineContexts?: readonly string[];
    readonly writingStyleIds?: readonly string[];
    readonly forceText?: boolean;
    readonly fromImageOcr?: boolean;
  }): Promise<boolean> => {
    const value = (submission?.text ?? text).trim();
    const submittedMode = submission?.forceText === true ? 'text' : mode;
    const submittedDirection = submission?.direction ?? conversationDirection;
    const submittedConversationReady =
      submittedMode !== 'conversation' ||
      submittedDirection === 'outgoing' ||
      settings?.nativeLanguage != null;
    if (
      submittingRef.current ||
      // 画像の読み取り中に手動で翻訳を始めると、読み取り完了時の翻訳開始と競合して
      // 書き起こし文が入力欄ごと隠れてしまう。読み取り完了側の送信だけを通す。
      imageExtractionActiveRef.current ||
      (imageStage?.phase === 'reading' && submission?.fromImageOcr !== true) ||
      !value ||
      !status.translationConfigured ||
      !submittedConversationReady
    )
      return Promise.resolve(false);
    const submittedContexts = submission?.inlineContexts ?? inlineContexts;
    const submittedStyleIds = submission?.writingStyleIds ?? selectedWritingStyleIds;
    const submittedStyles = composerStyles.filter((style) => submittedStyleIds.includes(style.id));
    const submittedAdditionalInstruction =
      submission?.writingStyleIds === undefined ? additionalInstruction : '';
    const submittedWritingStyle =
      submission?.forceText === true
        ? composeWritingStyleInstruction({
            mode: 'text',
            enabled: submittedStyleIds.length > 0,
            styles: submittedStyles,
            additionalInstruction: submittedAdditionalInstruction,
            additionalInstructionLabel: t('main.additionalInstruction'),
          })
        : activeWritingStyle;
    const submissionEpoch = ++submissionEpochRef.current;
    // 翻訳後も「実際に送信した指示」を表示するため、送信時点で表示用データを固定する。
    // 文体UIの現在値から都度再計算すると、翻訳中の設定変更で結果の表示とリクエストがずれる。
    const submittedInstructions = appliedTranslationInstructions({
      inlineContexts: submittedContexts,
      writingStyles: submittedWritingStyle === null ? [] : submittedStyles,
      additionalInstruction: submittedWritingStyle === null ? '' : submittedAdditionalInstruction,
    });
    const activeState =
      submittedMode === 'conversation' &&
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
      submittedMode === 'conversation' && activeCompletedTurn !== null
        ? [...conversationTurns, activeCompletedTurn]
        : conversationTurns;
    const conversationContext =
      submittedMode === 'conversation'
        ? conversationContextForTurns(previousConversationTurns)
        : [];
    const requestedTargetLanguage =
      submittedMode !== 'conversation'
        ? targetLanguageOverride
        : submittedDirection === 'incoming'
          ? null
          : conversationReplyTargetLanguage(previousConversationTurns, targetLanguage);
    // A ref closes the same-event-loop double-submit window before React can render disabled UI.
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    if (submittedMode === 'conversation') {
      setConversationTurns(previousConversationTurns);
      setResumedConversationTurn(null);
      setActiveConversationSubmission({
        id: crypto.randomUUID(),
        direction: submittedDirection,
        sourceText: value,
        appliedInstructions: submittedInstructions,
        previousRequestId: state.phase === 'selection' ? state.requestId : null,
      });
    } else if (submission?.forceText === true) {
      setMode('text');
      setConversationTurns([]);
      setResumedConversationTurn(null);
      setActiveConversationSubmission(null);
      setConversationSessionId(crypto.randomUUID());
      onConversationRoutingChange('text', 'incoming');
    }
    return (
      window.fumu
        .translateText(
          value,
          submittedMode === 'conversation' ? submittedDirection : null,
          submittedWritingStyle,
          submittedContexts,
          submittedInstructions,
          requestedTargetLanguage,
          conversationContext,
          submittedMode === 'conversation' ? conversationSessionId : null,
        )
        // The main process publishes the new selection state before this IPC invocation resolves.
        // Keep the rich editor mounted until then so a rejected invocation cannot remount an empty
        // editor while leaving an invisible parent submission value behind.
        .then(() => {
          if (submissionEpoch !== submissionEpochRef.current) return false;
          submittingRef.current = false;
          setSubmitting(false);
          if (submission?.forceText === true) {
            clearImageStage();
            clearResultImage();
          }
          setResultInstructions(submittedInstructions);
          setDrafting(false);
          return true;
        })
        .catch(() => {
          if (submissionEpoch !== submissionEpochRef.current) return false;
          submittingRef.current = false;
          setSubmitting(false);
          setSubmitError(t('main.startError'));
          return false;
        })
    );
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const clearImageStage = (): void => {
    if (imagePreviewUrlRef.current !== null) {
      URL.revokeObjectURL(imagePreviewUrlRef.current);
      imagePreviewUrlRef.current = null;
    }
    setImageStage(null);
  };
  const clearResultImage = (): void => {
    if (resultImageUrlRef.current !== null) {
      URL.revokeObjectURL(resultImageUrlRef.current);
      resultImageUrlRef.current = null;
    }
    setResultImage(null);
  };
  const readImage = (file: File, extractionMode: 'configured' | 'model' = 'configured'): void => {
    // 翻訳の開始中に読み取りを始めると、開始完了で入力欄が閉じて書き起こし文が翻訳されない。
    if (submittingRef.current) return;
    setSubmitError(null);
    const cancelPrevious = imageExtractionActiveRef.current;
    imageExtractionActiveRef.current = false;
    const requestId = ++imageRequestIdRef.current;
    clearImageStage();
    if (file.size > MAX_IMAGE_INPUT_BYTES) {
      if (cancelPrevious) {
        void window.fumu.cancelImageTextExtraction().catch(() => undefined);
      }
      setSubmitError(t('main.imageTooLarge'));
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    imagePreviewUrlRef.current = previewUrl;
    setImageStage({ previewUrl, phase: 'reading' });

    void (async () => {
      let extracting = false;
      let keepImageStage = false;
      const showImageError = (
        message: string,
        action:
          | { readonly type: 'model'; readonly file: File }
          | { readonly type: 'settings' }
          | null = null,
      ): void => {
        keepImageStage = true;
        setImageStage({ previewUrl, phase: 'error', message, action });
      };
      try {
        if (cancelPrevious) {
          await window.fumu.cancelImageTextExtraction().catch(() => undefined);
        }
        const image = await imagePayloadFromFile(file);
        if (requestId !== imageRequestIdRef.current) return;
        extracting = true;
        imageExtractionActiveRef.current = true;
        const outcome = await window.fumu.extractImageText(image, extractionMode);
        if (requestId !== imageRequestIdRef.current) return;
        switch (outcome.status) {
          case 'completed': {
            if (outcome.text.trim().length === 0) {
              showImageError(t('main.imageNoText'));
              break;
            }
            // 画像は入力途中の文と混ぜず、それ単体の新しい翻訳として扱う。
            const sourceText = Array.from(outcome.text)
              .slice(0, MAX_TRANSLATION_SOURCE_CODE_POINTS)
              .join('');
            imageExtractionActiveRef.current = false;
            keepImageStage = true;
            setImageStage({ previewUrl, phase: 'translating', text: sourceText });
            // setImageStageはこの呼び出し元のレンダーには反映されないため、OCR送信だけ読み取り中のガードを通す。
            const started = await submitRef.current({ text: sourceText, fromImageOcr: true });
            if (!started && requestId === imageRequestIdRef.current) {
              // モデル未設定やIPC失敗時だけ書き起こしを編集可能な入力欄へ戻す。
              editorRef.current?.appendText(sourceText);
              clearImageStage();
            }
            break;
          }
          case 'no-text':
            if (
              extractionMode === 'configured' &&
              settings?.imageTextRecognition === 'system' &&
              status.translationConfigured
            ) {
              showImageError(t('main.imageNoText'), { type: 'model', file });
            } else {
              showImageError(t('main.imageNoText'));
            }
            break;
          case 'unavailable':
            if (settings?.imageTextRecognition === 'system' && status.translationConfigured) {
              showImageError(t('main.imageOcrUnavailable'), { type: 'model', file });
            } else if (!status.translationConfigured) {
              showImageError(t('main.imageOcrUnavailable'), { type: 'settings' });
            } else {
              showImageError(t('main.imageOcrUnavailable'));
            }
            break;
          case 'cancelled':
            break;
          case 'failed':
            if (outcome.code === 'unsupported-input') {
              showImageError(t('main.imageModelUnsupported'), { type: 'settings' });
            } else if (outcome.code === 'image-too-large') {
              showImageError(t('main.imageTooLarge'));
            } else if (outcome.code === 'invalid-image') {
              showImageError(t('main.imageInvalid'));
            } else {
              showImageError(outcome.message);
            }
            break;
        }
      } catch (error) {
        if (requestId !== imageRequestIdRef.current) return;
        if (error instanceof ImageInputTooLargeError) {
          showImageError(t('main.imageTooLarge'));
        } else if (!extracting) {
          showImageError(t('main.imageUnreadable'));
        } else {
          showImageError(t('common.genericError'));
        }
      } finally {
        if (requestId === imageRequestIdRef.current) {
          imageExtractionActiveRef.current = false;
          // 翻訳開始後とエラー表示では画像翻訳の画面を保ち、明示的な取消までホームへ戻さない。
          if (!keepImageStage) clearImageStage();
        }
      }
    })();
  };
  const readImageFromAnotherTextBar = (file: File): void => {
    if (!drafting) {
      clearResultImage();
      setDrafting(true);
      if (mode === 'conversation') {
        setMode('text');
        setConversationTurns([]);
        setResumedConversationTurn(null);
        setActiveConversationSubmission(null);
        setConversationSessionId(crypto.randomUUID());
        onConversationRoutingChange('text', 'incoming');
      }
    }
    readImage(file);
  };
  useEffect(() => {
    if (imageStage?.phase !== 'translating') return;
    if (!drafting) {
      // 結果画面へ切り替わったら、読み取り中の画像を結果の原文カードへ引き継ぐ（revokeしない）。
      if (resultImageUrlRef.current !== null) URL.revokeObjectURL(resultImageUrlRef.current);
      resultImageUrlRef.current = imageStage.previewUrl;
      imagePreviewUrlRef.current = null;
      setResultImage({ url: imageStage.previewUrl, sourceTexts: [imageStage.text] });
      setImageStage(null);
    }
  }, [imageStage, drafting, submitting]);
  useEffect(() => {
    if (pendingImage === null) return;
    // 履歴を開いて戻るなどでComposerが再マウントされても同じ画像を読み直さないよう、すぐ消費済みにする。
    // readImageは描画ごとに作り直されるため依存に含めない。
    readImage(pendingImage.file);
    onPendingImageConsumed();
  }, [pendingImage?.id]);
  useEffect(() => {
    if (pendingSubmission === null) return;
    onPendingSubmissionConsumed();
    void submitRef.current({ ...pendingSubmission.submission, forceText: true });
  }, [pendingSubmission?.id]);
  useEffect(() => {
    if (focusInputRequestId === null) return;
    const requestId = focusInputRequestId;
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      onInputFocusRequestHandled(requestId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusInputRequestId, onInputFocusRequestHandled]);
  useEffect(
    () => () => {
      imageRequestIdRef.current += 1;
      if (imageExtractionActiveRef.current) {
        imageExtractionActiveRef.current = false;
        void window.fumu.cancelImageTextExtraction().catch(() => undefined);
      }
      if (imagePreviewUrlRef.current !== null) {
        URL.revokeObjectURL(imagePreviewUrlRef.current);
        imagePreviewUrlRef.current = null;
      }
      if (resultImageUrlRef.current !== null) {
        URL.revokeObjectURL(resultImageUrlRef.current);
        resultImageUrlRef.current = null;
      }
    },
    [],
  );
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
  useEffect(
    () => () => {
      if (styleAdjustCloseTimerRef.current !== null) {
        window.clearTimeout(styleAdjustCloseTimerRef.current);
      }
    },
    [],
  );
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
  const showingImageStage = imageStage !== null && drafting;
  const showTranslationShortcutHint = status.hotkeyState === 'registered';
  const showScreenshotShortcutHint =
    settings?.screenshotShortcut != null && status.screenshotHotkeyState === 'registered';
  return (
    <div className="translate-workspace composer-workspace">
      {showingResult ? (
        <div className="nani-result-actions">
          <AnotherTextBar
            settings={settings}
            enterToSend={settings?.enterToSend === true}
            translationConfigured={status.translationConfigured}
            busy={submitting || imageStage?.phase === 'reading'}
            onSubmit={(value) => submit({ ...value, forceText: true })}
            onImageFile={readImageFromAnotherTextBar}
            openSettings={openSettings}
            openWritingStyles={openWritingStyles}
          />
        </div>
      ) : (
        <>
          {showingImageStage && (
            <>
              <div className="nani-result-actions">
                <AnotherTextBar
                  settings={settings}
                  enterToSend={settings?.enterToSend === true}
                  translationConfigured={status.translationConfigured}
                  busy={submitting || imageStage?.phase === 'reading'}
                  onSubmit={(value) => submit({ ...value, forceText: true })}
                  onImageFile={readImageFromAnotherTextBar}
                  openSettings={openSettings}
                  openWritingStyles={openWritingStyles}
                />
              </div>
              <section className="nani-result-flow" aria-live="polite">
                <article
                  className="nani-source-card has-image"
                  aria-busy={imageStage.phase !== 'error'}
                >
                  <img
                    className="nani-source-image"
                    src={imageStage.previewUrl}
                    alt={t('result.sourceImage')}
                  />
                  {imageStage.phase !== 'error' && (
                    <div className="nani-loading-lines" aria-hidden="true">
                      <span />
                      <span />
                    </div>
                  )}
                </article>
                {imageStage.phase !== 'error' && (
                  <div className="translation-arrived">
                    <span className="mini-brand">
                      <FumuMascot animated />
                    </span>
                    <span role="status">
                      {imageStage.phase === 'reading'
                        ? t('main.imageReading')
                        : t('main.imageTranslating')}
                    </span>
                  </div>
                )}
                <article
                  className={
                    imageStage.phase === 'error'
                      ? 'nani-result-card image-stage-error'
                      : 'nani-result-card'
                  }
                  aria-busy={imageStage.phase !== 'error'}
                >
                  {imageStage.phase === 'error' ? (
                    <div className="nani-error" role="alert">
                      <span>{imageStage.message}</span>
                      {imageStage.action?.type === 'model' && (
                        <button
                          className="text-button image-model-retry"
                          type="button"
                          onClick={() => {
                            const action = imageStage.action;
                            if (action?.type === 'model') readImage(action.file, 'model');
                          }}
                        >
                          {t('common.readWithAi')}
                        </button>
                      )}
                      {imageStage.action?.type === 'settings' && (
                        <button className="text-button" type="button" onClick={openSettings}>
                          {t('common.settings')}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="nani-loading-lines" aria-hidden="true">
                      <span />
                      <span />
                    </div>
                  )}
                </article>
              </section>
            </>
          )}
          {/* 読み取り中も入力欄はunmountせず隠すだけにする。書き起こし文は入力欄へ追記してから
            送信するため、unmountすると入力途中の文や文脈指定が失われる。 */}
          <section
            hidden={showingImageStage}
            className={
              styleAdjustEnabled
                ? 'nani-composer-shell style-adjust-enabled'
                : 'nani-composer-shell'
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
                      className={
                        selectedWritingStyleIds.includes(style.id) ? 'selected' : undefined
                      }
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
                    aria-pressed={
                      additionalInstructionOpen || additionalInstructionValue.length > 0
                    }
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
                ref={editorRef}
                label={mode === 'conversation' ? t('main.messageLabel') : t('main.textLabel')}
                placeholder={
                  mode === 'conversation' ? t('main.messagePlaceholder') : t('main.textPlaceholder')
                }
                submitOnEnter={settings?.enterToSend === true}
                {...(pendingSubmission === null
                  ? {}
                  : {
                      initialValue: {
                        text: pendingSubmission.submission.text,
                        inlineContexts: pendingSubmission.submission.inlineContexts,
                      },
                    })}
                onImageFile={readImage}
                onChange={(value) => {
                  setText(value.text);
                  setInlineContexts(value.inlineContexts);
                }}
                onSubmit={submit}
              />
              <footer>
                <QuickSettingsControl settings={settings} openSettings={openSettings} />
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
        </>
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
          sourceImageUrl={
            resultImage !== null && resultImage.sourceTexts.includes(state.selection.text)
              ? resultImage.url
              : null
          }
          onEditSource={(editedText) => {
            // 画像から読んだ原文を直した場合も、同じ画像の翻訳として画像表示を続ける。
            setResultImage((current) =>
              current !== null && current.sourceTexts.includes(state.selection.text)
                ? { ...current, sourceTexts: [...current.sourceTexts, editedText] }
                : current,
            );
            submitRef.current({ text: editedText });
          }}
          translation={state.translation}
          followUpMessages={state.followUpMessages}
          appliedInstructions={resultInstructions}
        />
      ) : null}
      {!showingResult && !showingImageStage && (
        <div className="translation-mode-cards">
          <button
            className="mode-card"
            type="button"
            onClick={() => imageFileInputRef.current?.click()}
          >
            <ImageIcon size={23} />
            <span>
              <strong>{t('main.imageTitle')}</strong>
              <small>{t('main.imageDetail')}</small>
            </span>
          </button>
          <input
            ref={imageFileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              // 同じ画像を続けて選び直せるよう、選択値は毎回空に戻す。
              event.currentTarget.value = '';
              if (file !== undefined) readImage(file);
            }}
          />
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
      {!showingResult &&
        !showingImageStage &&
        (showTranslationShortcutHint || showScreenshotShortcutHint) && (
          <div className="hotkey-hints">
            {showTranslationShortcutHint && (
              <p className="hotkey-hint">
                <span />
                <kbd>
                  {displayAccelerator(status.hotkey, t('common.notConfigured')).replaceAll(
                    ' + ',
                    ' ',
                  )}
                </kbd>
                {t('main.selectionHint')}
              </p>
            )}
            {showScreenshotShortcutHint &&
              settings !== null &&
              settings.screenshotShortcut !== null && (
                <p className="hotkey-hint">
                  <span />
                  <kbd>
                    {displayAccelerator(
                      settings.screenshotShortcut,
                      t('common.notConfigured'),
                    ).replaceAll(' + ', ' ')}
                  </kbd>
                  {t('main.screenshotHint')}
                </p>
              )}
          </div>
        )}
    </div>
  );
}

function HistoryTranslationResult({
  detail,
  onResumeConversation,
  settings,
  translationConfigured,
  onSubmit,
  onImageFile,
  openSettings,
  openWritingStyles,
}: {
  readonly detail: HistoryDetail;
  readonly onResumeConversation: (conversation: ResumableConversation) => void;
  readonly settings: SettingsSnapshot | null;
  readonly translationConfigured: boolean;
  readonly onSubmit: (submission: AnotherTextSubmission) => Promise<boolean>;
  readonly onImageFile: (file: File) => void;
  readonly openSettings: () => void;
  readonly openWritingStyles: () => void;
}) {
  const { t } = useI18n();
  const conversationTurns = conversationTranslationTurnsFromHistory(detail.results);
  if (conversationTurns.length > 0) {
    return (
      <div className="translate-workspace history-result-workspace">
        <div className="nani-result-actions">
          <AnotherTextBar
            settings={settings}
            enterToSend={settings?.enterToSend === true}
            translationConfigured={translationConfigured}
            busy={false}
            onSubmit={onSubmit}
            onImageFile={onImageFile}
            openSettings={openSettings}
            openWritingStyles={openWritingStyles}
          />
        </div>
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
      <div className="nani-result-actions">
        <AnotherTextBar
          settings={settings}
          enterToSend={settings?.enterToSend === true}
          translationConfigured={translationConfigured}
          busy={false}
          onSubmit={onSubmit}
          onImageFile={onImageFile}
          openSettings={openSettings}
          openWritingStyles={openWritingStyles}
        />
      </div>
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
  const [pendingImage, setPendingImage] = useState<{
    readonly id: number;
    readonly file: File;
  } | null>(null);
  const [pendingSubmission, setPendingSubmission] = useState<{
    readonly id: number;
    readonly submission: AnotherTextSubmission;
  } | null>(null);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [screenCapturePending, setScreenCapturePending] = useState(false);
  const screenCapturePendingRef = useRef(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyDialogItems, setHistoryDialogItems] = useState<readonly HistoryListItem[]>([]);
  const [historyDialogHasMore, setHistoryDialogHasMore] = useState(false);
  const [historyDialogLoading, setHistoryDialogLoading] = useState(false);
  const [historyDialogError, setHistoryDialogError] = useState<string | null>(null);
  const historyDialogRequestIdRef = useRef(0);
  const historyDialogLoadingRef = useRef(false);
  const closeHistoryDialogRef = useRef<() => void>(() => undefined);
  const [focusInputRequestId, setFocusInputRequestId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
      return Number.isFinite(storedWidth) && storedWidth > 0
        ? clampSidebarWidth(storedWidth)
        : DEFAULT_SIDEBAR_WIDTH;
    } catch {
      return DEFAULT_SIDEBAR_WIDTH;
    }
  });
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarResizeDragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
  } | null>(null);
  const historyDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const historyDialogRef = useRef<HTMLDivElement>(null);
  const handledManualRequestIdRef = useRef<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const logoTargetRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const settingsCloseTimerRef = useRef<number | null>(null);
  const status = useDesktopStatus();
  const settingsState = useSettings(t('common.settingsLoadError'));
  const recentHistory = useRecentHistory();
  const translationState = useMainTranslation();
  const loadHistoryDialogPage = (offset: number, requestId: number): void => {
    if (historyDialogLoadingRef.current) return;
    historyDialogLoadingRef.current = true;
    setHistoryDialogLoading(true);
    setHistoryDialogError(null);
    void window.fumu
      .listHistory({ query: '', limit: HISTORY_PAGE_SIZE, offset })
      .then((items) => {
        if (requestId !== historyDialogRequestIdRef.current) return;
        setHistoryDialogItems((current) => (offset === 0 ? items : [...current, ...items]));
        setHistoryDialogHasMore(items.length === HISTORY_PAGE_SIZE);
      })
      .catch(() => {
        if (requestId === historyDialogRequestIdRef.current) {
          setHistoryDialogError(t('common.genericError'));
        }
      })
      .finally(() => {
        if (requestId !== historyDialogRequestIdRef.current) return;
        historyDialogLoadingRef.current = false;
        setHistoryDialogLoading(false);
      });
  };
  const openHistoryDialog = (): void => {
    const requestId = ++historyDialogRequestIdRef.current;
    historyDialogLoadingRef.current = false;
    setHistoryDialogItems([]);
    setHistoryDialogHasMore(false);
    setHistoryDialogError(null);
    setHistoryDialogOpen(true);
    loadHistoryDialogPage(0, requestId);
  };
  const closeHistoryDialog = (): void => {
    historyDialogRequestIdRef.current += 1;
    historyDialogLoadingRef.current = false;
    setHistoryDialogLoading(false);
    setHistoryDialogOpen(false);
  };
  closeHistoryDialogRef.current = closeHistoryDialog;
  const loadMoreHistory = (): void => {
    loadHistoryDialogPage(historyDialogItems.length, historyDialogRequestIdRef.current);
  };
  const targetLanguage = targetLanguageOverride ?? displayedTargetLanguage(settingsState.settings);
  const onboardingActive = settingsState.settings?.onboardingCompleted !== true;
  const sidebarLanguageVisible =
    composerRouting.mode !== 'conversation' || composerRouting.direction === 'outgoing';
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
    closeHistoryDialog();
    setComposerKey((value) => value + 1);
  };
  // どの画面にいても、画像の貼り付け・ドロップで新しい画像翻訳を始める。
  // 入力欄は自身で画像を受け取る（入力中の文脈や文体を保つため）ので、処理済みの操作は扱わない。
  const imageIntakeBlockedRef = useRef(false);
  imageIntakeBlockedRef.current = settingsRendered || onboardingActive;
  const startImageTranslationRef = useRef<(file: File) => void>(() => undefined);
  startImageTranslationRef.current = (file) => {
    goHome();
    setPendingImage((current) => ({ id: (current?.id ?? 0) + 1, file }));
  };
  const captureScreen = async (): Promise<void> => {
    if (screenCapturePendingRef.current || settingsRendered || onboardingActive) return;
    screenCapturePendingRef.current = true;
    setScreenCapturePending(true);
    try {
      const image = await window.fumu.captureScreenRegionForMain();
      if (image !== null) {
        const data = new ArrayBuffer(image.data.byteLength);
        new Uint8Array(data).set(image.data);
        startImageTranslationRef.current(
          new File([data], 'screenshot.png', { type: image.mediaType }),
        );
      }
    } catch {
      // 取消や失敗はmain側の契約どおり画面を切り替えず、撮影ボタンを再度使える状態へ戻す。
    } finally {
      screenCapturePendingRef.current = false;
      setScreenCapturePending(false);
    }
  };
  useEffect(() => {
    if (sidebarResizing) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // 保存できない環境でも、現在のウィンドウ内では幅変更を使えるようにする。
    }
  }, [sidebarResizing, sidebarWidth]);
  useEffect(() => {
    document.body.classList.toggle('sidebar-resizing', sidebarResizing);
    return () => document.body.classList.remove('sidebar-resizing');
  }, [sidebarResizing]);
  useEffect(() => {
    if (!historyDialogOpen) return;
    const dialog = historyDialogRef.current;
    const focusable = (): HTMLElement[] =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const frame = window.requestAnimationFrame(() => focusable()[0]?.focus());
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeHistoryDialogRef.current();
        window.requestAnimationFrame(() => historyDialogTriggerRef.current?.focus());
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
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
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [historyDialogOpen]);
  useEffect(() => {
    const imageFileFrom = (data: DataTransfer | null): File | null => {
      if (data === null) return null;
      for (const item of Array.from(data.items)) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file !== null) return file;
      }
      return Array.from(data.files).find((file) => file.type.startsWith('image/')) ?? null;
    };
    const carriesFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const handlePaste = (event: ClipboardEvent): void => {
      if (event.defaultPrevented || imageIntakeBlockedRef.current) return;
      const data = event.clipboardData;
      // Wordなど文字と画像が同時に入った貼り付けは、従来どおり文字の貼り付けとして扱う。
      if (data === null || data.getData('text/plain').trim().length > 0) return;
      const file = imageFileFrom(data);
      if (file === null) return;
      event.preventDefault();
      startImageTranslationRef.current(file);
    };
    const handleDragOver = (event: DragEvent): void => {
      if (imageIntakeBlockedRef.current || !carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
      setImageDragActive(true);
    };
    const handleDragLeave = (event: DragEvent): void => {
      // 子要素間の移動でも発火するため、ウィンドウの外へ出たときだけ解除する。
      if (event.relatedTarget === null) setImageDragActive(false);
    };
    const handleDrop = (event: DragEvent): void => {
      setImageDragActive(false);
      if (!carriesFiles(event)) return;
      // ファイルのドロップは既定でそのファイルへの遷移になるため、画像以外でも必ず止める。
      const alreadyHandled = event.defaultPrevented;
      event.preventDefault();
      if (alreadyHandled || imageIntakeBlockedRef.current) return;
      const file = imageFileFrom(event.dataTransfer);
      if (file !== null) startImageTranslationRef.current(file);
    };
    document.addEventListener('paste', handlePaste);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);
    return () => {
      document.removeEventListener('paste', handlePaste);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('drop', handleDrop);
    };
  }, []);
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
    closeHistoryDialogRef.current();
  }, [dismissedTranslationRequestId, translationState.phase, translationState.requestId]);
  useEffect(() => {
    // 同じmanual requestの再通知でComposerを作り直さないよう、requestId単位で一度だけ処理する。
    if (
      translationState.phase !== 'manual' ||
      translationState.requestId === handledManualRequestIdRef.current
    ) {
      return;
    }
    handledManualRequestIdRef.current = translationState.requestId;
    if (settingsCloseTimerRef.current !== null) {
      window.clearTimeout(settingsCloseTimerRef.current);
      settingsCloseTimerRef.current = null;
    }
    setSettingsOpen(false);
    setSettingsRendered(false);
    setSettingsTarget('general');
    setPage('translate');
    setSelectedHistoryId(null);
    setHistoryDetail(null);
    setHistoryError(null);
    setInitialConversation(null);
    setComposerRouting({ mode: 'text', direction: 'incoming' });
    closeHistoryDialogRef.current();
    setFocusInputRequestId(translationState.requestId);
    setComposerKey((value) => value + 1);
  }, [translationState.phase, translationState.requestId]);
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
    closeHistoryDialog();
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
      style={{ '--nani-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <aside
        className="nani-sidebar"
        inert={settingsRendered || onboardingActive || historyDialogOpen}
      >
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
          <div className="sidebar-language-tools">
            {sidebarLanguageVisible && (
              <TargetLanguageSelect
                className="sidebar-language"
                value={targetLanguage}
                onChange={setTargetLanguageOverride}
              />
            )}
            <ScreenCaptureButton
              disabled={screenCapturePending}
              onClick={() => void captureScreen()}
            />
          </div>
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
        <div
          className="sidebar-resize-handle"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('main.resizeSidebar')}
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            sidebarResizeDragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startWidth: sidebarWidth,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setSidebarResizing(true);
          }}
          onPointerMove={(event) => {
            const drag = sidebarResizeDragRef.current;
            if (drag === null || drag.pointerId !== event.pointerId) return;
            setSidebarWidth(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
          }}
          onPointerUp={(event) => {
            if (sidebarResizeDragRef.current?.pointerId !== event.pointerId) return;
            sidebarResizeDragRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            setSidebarResizing(false);
          }}
          onPointerCancel={(event) => {
            if (sidebarResizeDragRef.current?.pointerId !== event.pointerId) return;
            sidebarResizeDragRef.current = null;
            setSidebarResizing(false);
          }}
          onLostPointerCapture={(event) => {
            if (sidebarResizeDragRef.current?.pointerId !== event.pointerId) return;
            sidebarResizeDragRef.current = null;
            setSidebarResizing(false);
          }}
          onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const amount = event.key === 'ArrowRight' ? 16 : -16;
            setSidebarWidth((width) => clampSidebarWidth(width + amount));
          }}
        />
      </aside>
      <MiniRail
        targetLanguage={targetLanguage}
        showTargetLanguage={sidebarLanguageVisible}
        onTargetLanguageChange={setTargetLanguageOverride}
        historyItems={historyRows}
        selectedHistoryId={selectedHistoryId}
        onHome={goHome}
        onCapture={() => void captureScreen()}
        capturePending={screenCapturePending}
        {...(settingsState.settings?.screenshotShortcut == null ||
        status.screenshotHotkeyState !== 'registered'
          ? {}
          : {
              captureShortcut: displayAccelerator(
                settingsState.settings.screenshotShortcut,
                t('common.notConfigured'),
              ).replaceAll(' + ', ' '),
            })}
        onHistorySelect={(id) => {
          setSelectedHistoryId(id);
          setHistoryDetail(null);
          setHistoryError(null);
          setPage('history');
        }}
        onShowAllHistory={openHistoryDialog}
        allHistoryButtonRef={historyDialogTriggerRef}
        onOpenSettings={() => openSettings()}
        inert={settingsRendered || onboardingActive || historyDialogOpen}
      />
      {historyDialogOpen && (
        <div
          className="history-dialog-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeHistoryDialog();
              window.requestAnimationFrame(() => historyDialogTriggerRef.current?.focus());
            }
          }}
        >
          <div
            ref={historyDialogRef}
            className="history-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-dialog-title"
          >
            <header>
              <h2 id="history-dialog-title">{t('main.historyTitle')}</h2>
              <button
                className="history-dialog-close"
                type="button"
                aria-label={t('common.close')}
                title={t('common.close')}
                onClick={() => {
                  closeHistoryDialog();
                  window.requestAnimationFrame(() => historyDialogTriggerRef.current?.focus());
                }}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <div className="history-dialog-list">
              {historyDialogItems.length > 0
                ? historyDialogItems.map((item) => (
                    <button
                      key={item.id}
                      className="history-dialog-card"
                      type="button"
                      aria-current={selectedHistoryId === item.id ? 'page' : undefined}
                      onClick={() => {
                        closeHistoryDialog();
                        setSelectedHistoryId(item.id);
                        setHistoryDetail(null);
                        setHistoryError(null);
                        setPage('history');
                        window.requestAnimationFrame(() =>
                          historyDialogTriggerRef.current?.focus(),
                        );
                      }}
                    >
                      <strong>{item.sourceText}</strong>
                      <span>{item.translation}</span>
                    </button>
                  ))
                : null}
              {historyDialogLoading && <p role="status">{t('common.loading')}</p>}
              {historyDialogError && <p role="alert">{historyDialogError}</p>}
              {!historyDialogLoading && !historyDialogError && historyDialogItems.length === 0 && (
                <p>{t('history.empty')}</p>
              )}
              {(historyDialogHasMore || historyDialogError !== null) && (
                <button
                  className="history-dialog-more"
                  type="button"
                  disabled={historyDialogLoading}
                  onClick={
                    historyDialogError === null
                      ? loadMoreHistory
                      : () =>
                          loadHistoryDialogPage(
                            historyDialogItems.length,
                            historyDialogRequestIdRef.current,
                          )
                  }
                >
                  {historyDialogLoading
                    ? t('common.loading')
                    : historyDialogError === null
                      ? t('main.loadMoreHistory')
                      : t('common.retry')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {imageDragActive && (
        <div className="image-drop-overlay" aria-hidden="true">
          <ImageIcon size={26} />
          <span>{t('main.imageTitle')}</span>
        </div>
      )}
      <section
        className="nani-canvas"
        inert={settingsRendered || onboardingActive || historyDialogOpen}
      >
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
            pendingImage={pendingImage}
            onPendingImageConsumed={() => setPendingImage(null)}
            pendingSubmission={pendingSubmission}
            onPendingSubmissionConsumed={() => setPendingSubmission(null)}
            focusInputRequestId={focusInputRequestId}
            onInputFocusRequestHandled={(requestId) =>
              setFocusInputRequestId((current) => (current === requestId ? null : current))
            }
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
                settings={settingsState.settings}
                translationConfigured={status.translationConfigured}
                onImageFile={(file) => startImageTranslationRef.current(file)}
                openSettings={openSettings}
                openWritingStyles={() => openSettings('writing-styles')}
                onSubmit={(submission) => {
                  setPendingSubmission((current) => ({
                    id: (current?.id ?? 0) + 1,
                    submission,
                  }));
                  goHome();
                  return Promise.resolve(true);
                }}
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
                screenshotHotkeyState={status.screenshotHotkeyState}
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
