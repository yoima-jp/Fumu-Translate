import { randomUUID } from 'node:crypto';
import log from 'electron-log/main';
import type {
  ConversationContextTurn,
  FollowUpEvent,
  FollowUpMessage,
  FollowUpRequest,
  FollowUpService,
  TranslationActionOperation,
  TranslationEvent,
  TranslationOperation,
  TranslationRequest,
  TranslationResult,
  TranslationService,
} from '@fumu/translation-core';
import {
  MAX_TRANSLATION_SOURCE_CODE_POINTS,
  validateInlineTranslationContexts,
} from '@fumu/translation-core';
import type {
  DesktopStatus,
  HotkeyRegistrationState,
  Point,
  PopupResizeRequest,
  ResolvedSelection,
  SelectionAnchor,
} from '../shared/contracts';
import type { HistoryDetail, HistoryListItem, HistoryQuery } from '../shared/history-contracts';
import {
  MAX_APPLIED_TRANSLATION_INSTRUCTIONS,
  normalizeAppliedTranslationInstructionLabel,
  type AppliedTranslationInstruction,
} from '../shared/applied-translation-instructions-contract';
import type {
  GeneralSettingsUpdate,
  FetchProviderModelsRequest,
  ProviderModel,
  SaveProviderRequest,
  SettingsSnapshot,
  ShortcutUpdateResult,
  UpdateUsedModelsRequest,
  WritingStyleInstruction,
} from '../shared/settings-contracts';
import type { HotkeyRegistration } from './os/hotkey/electron-hotkey-service';
import { SelectionTextTooLargeError } from './os/selection/selection-hook-service';

export const MAX_CLIPBOARD_TEXT_CODE_POINTS = 100_000;
const POPUP_DISMISS_HOTKEY = 'Escape';

export interface ClipboardPort {
  readText(): Promise<string | null>;
  writeText(text: string): Promise<void>;
}

export interface HotkeyPort {
  register(accelerator: string, callback: () => void): HotkeyRegistration;
  registerTransient(accelerator: string, callback: () => void): boolean;
  unregisterTransient(accelerator: string): void;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

export interface SelectionPort {
  readonly isRunning: boolean;
  start(): Promise<void>;
  recentAnchor(): SelectionAnchor | null;
  resolveSelection(): Promise<ResolvedSelection | null>;
  onMouseDown(listener: (point: Point) => void): () => void;
  stop(): Promise<void>;
}

export interface PopupWindowPort {
  readonly isVisible: boolean;
  setDismissHandler(handler: (() => void) | null): void;
  initialize(): Promise<void>;
  showCapturing(requestId: string, preferredAnchor: SelectionAnchor | null): void;
  showSelection(requestId: string, selection: ResolvedSelection): void;
  showSelectionInMain(requestId: string, selection: ResolvedSelection): void;
  beginTranslationOperation(
    requestId: string,
    operation: TranslationOperation,
    previousValue: TranslationResult | null,
    writingStyleName?: string,
  ): void;
  showTranslationEvent(event: TranslationEvent): void;
  showFollowUpStarted(requestId: string, question: string): void;
  showFollowUpEvent(event: FollowUpEvent): void;
  showManual(requestId: string, clipboardText: string | null): void;
  showError(requestId: string, message: string): void;
  showErrorInMain(requestId: string, message: string): void;
  resize(request: PopupResizeRequest): void;
  containsPhysicalPoint(point: Point): boolean;
  hide(): void;
  dispose(): void;
}

export interface MainWindowPort {
  initialize(): Promise<void>;
  sendStatus(status: DesktopStatus): void;
  sendSettings(settings: SettingsSnapshot): void;
  sendHistoryChanged(): void;
  show(): void;
  showInactive(): void;
  dispose(): void;
}

export type TranslationSurface = 'popup' | 'main';

export interface SettingsPort {
  readonly snapshot: SettingsSnapshot;
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void;
  setShortcut(shortcut: string): SettingsSnapshot;
  updateGeneral(update: GeneralSettingsUpdate): SettingsSnapshot;
  fetchModels(request: FetchProviderModelsRequest): Promise<readonly ProviderModel[]>;
  loginChatGpt(providerId: string): Promise<void>;
  saveProvider(request: SaveProviderRequest): SettingsSnapshot;
  deleteProvider(providerId: string): SettingsSnapshot;
  updateUsedModels(request: UpdateUsedModelsRequest): SettingsSnapshot;
}

export interface ProviderStatePort {
  readonly configured: boolean;
  readonly activeProviderName: string | null;
  readonly activeModelName: string | null;
  consumeCompletedModel(requestId: string): {
    readonly providerId: string | null;
    readonly providerName: string;
    readonly modelId: string;
  } | null;
}

export interface HistoryPort {
  recordTranslation(input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly selection: ResolvedSelection;
    readonly operation: TranslationOperation;
    readonly conversationDirection?: 'incoming' | 'outgoing' | null;
    readonly writingStyleName?: string;
    readonly appliedInstructions?: readonly AppliedTranslationInstruction[];
    readonly result: TranslationResult;
    readonly providerProfileId: string | null;
    readonly providerName: string | null;
    readonly modelId?: string | null;
    readonly createdAt: number;
  }): void;
  recordFollowUp(input: {
    readonly sessionId: string;
    readonly selection: ResolvedSelection;
    readonly question: string;
    readonly answer: string;
    readonly createdAt: number;
  }): void;
  list(query: string, limit: number): readonly HistoryListItem[];
  get(historyId: string): HistoryDetail | null;
  delete(historyId: string): void;
  clear(): void;
  purgeOlderThan(cutoff: number): number;
}

export interface AppControllerDependencies {
  readonly clipboard: ClipboardPort;
  readonly hotkey: HotkeyPort;
  readonly selection: SelectionPort;
  readonly translation: TranslationService;
  readonly followUp: FollowUpService;
  readonly popup: PopupWindowPort;
  readonly mainWindow: MainWindowPort;
  readonly settings: SettingsPort;
  readonly providers: ProviderStatePort;
  readonly history: HistoryPort;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export class AppController {
  readonly #logger = log.scope('app-controller');
  readonly #clipboard: ClipboardPort;
  readonly #hotkey: HotkeyPort;
  readonly #selection: SelectionPort;
  readonly #translation: TranslationService;
  readonly #followUp: FollowUpService;
  readonly #popup: PopupWindowPort;
  readonly #mainWindow: MainWindowPort;
  readonly #settings: SettingsPort;
  readonly #providers: ProviderStatePort;
  readonly #history: HistoryPort;

  #requestEpoch = 0;
  #activeRequestAbortController: AbortController | null = null;
  #activeSelection: ResolvedSelection | null = null;
  #activeTranslationResult: TranslationResult | null = null;
  #lastTranslationOperation: TranslationOperation = 'translate';
  #lastWritingStyle: WritingStyleInstruction | null = null;
  #lastInlineContexts: readonly string[] = [];
  #lastAppliedInstructions: readonly AppliedTranslationInstruction[] = [];
  #lastRequestedTargetLanguage: string | null = null;
  #mainConversationContext: readonly ConversationContextTurn[] = [];
  #followUpMessages: FollowUpMessage[] = [];
  #lastFailedFollowUp: string | null = null;
  #activeHistorySessionId: string | null = null;
  #historyHasTranslation = false;
  #historyRecordingEligible = false;
  #activeSurface: 'popup' | 'main' | null = null;
  #mainConversationDirection: 'incoming' | 'outgoing' | null = null;
  #hotkeyAccelerator: string;
  #hotkeyState: HotkeyRegistrationState = 'disabled';
  #shortcutCaptureActive = false;
  #hotkeyTriggerActive = false;
  #removeMouseDownListener: (() => void) | null = null;
  #removeSettingsListener: (() => void) | null = null;
  #disposed = false;
  #initialization: Promise<void> | null = null;
  #disposal: Promise<void> | null = null;

  constructor(dependencies: AppControllerDependencies) {
    this.#clipboard = dependencies.clipboard;
    this.#hotkey = dependencies.hotkey;
    this.#selection = dependencies.selection;
    this.#translation = dependencies.translation;
    this.#followUp = dependencies.followUp;
    this.#popup = dependencies.popup;
    this.#mainWindow = dependencies.mainWindow;
    this.#settings = dependencies.settings;
    this.#providers = dependencies.providers;
    this.#history = dependencies.history;
    this.#hotkeyAccelerator = dependencies.settings.snapshot.shortcut;
  }

  get status(): DesktopStatus {
    return {
      hotkey: this.#hotkeyAccelerator,
      hotkeyState: this.#hotkeyState,
      selectionServiceRunning: this.#selection.isRunning,
      popupVisible: this.#popup.isVisible,
      activeProviderName: this.#providers.activeProviderName,
      activeModelName: this.#providers.activeModelName,
      translationConfigured: this.#providers.configured,
    };
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  initialize(): Promise<void> {
    if (this.#initialization !== null) {
      return this.#initialization;
    }
    if (this.#disposed) {
      return Promise.resolve();
    }
    this.#initialization = this.#initializeResources();
    return this.#initialization;
  }

  async #initializeResources(): Promise<void> {
    this.#popup.setDismissHandler(() => this.closePopup());
    await this.#popup.initialize();
    if (this.#disposed) return;
    await this.#mainWindow.initialize();
    if (this.#disposed) return;
    this.#removeSettingsListener = this.#settings.subscribe((settings) => {
      this.#mainWindow.sendSettings(settings);
      this.#applyHistoryRetention(settings);
      this.#publishStatus();
    });
    this.#applyHistoryRetention(this.#settings.snapshot);

    try {
      await this.#selection.start();
      if (this.#disposed) {
        await this.#selection.stop();
        return;
      }
      this.#removeMouseDownListener = this.#selection.onMouseDown((point) => {
        if (this.#popup.isVisible && !this.#popup.containsPhysicalPoint(point)) {
          this.closePopup();
        }
      });
    } catch (error) {
      // Hookが起動できなくてもHotkeyとClipboard入力は使える。
      // 起動全体を失敗させず、状態をMain UIへ公開して復旧経路を残す。
      if (!this.#disposed) {
        this.#logger.error('Selection service failed to start', error);
      }
    }

    if (this.#disposed) return;

    const registration = this.#hotkey.register(this.#hotkeyAccelerator, () =>
      this.#triggerSelectionFromHotkey(),
    );
    this.#hotkeyState = registration.state;
    this.#mainWindow.sendSettings(this.#settings.snapshot);
    this.#publishStatus();
  }

  async triggerSelection(): Promise<void> {
    const surface: TranslationSurface = this.#settings.snapshot.compactTranslation
      ? 'popup'
      : 'main';
    const requestEpoch = this.#beginRequest();
    this.#clearActiveSession();
    this.#activeSurface = surface;
    const requestId = randomUUID();

    if (surface === 'popup') {
      // 選択取得は対象アプリやFallbackによって時間が変わる。
      // 先に非アクティブPopupを出し、取得処理を次のevent-loop turnへ譲る。
      this.#popup.showCapturing(requestId, this.#selection.recentAnchor());
      this.#registerPopupDismissHotkey();
    } else {
      // 選択内容を取得するまでは元アプリのフォーカスを維持する。通常のshow()で
      // メイン画面へフォーカスを移すとUI Automationが選択を見失い、古い
      // クリップボード内容へフォールバックしてしまう。
      this.#mainWindow.showInactive();
    }
    this.#publishStatus();
    await nextTurn();

    try {
      const selection = await this.#selection.resolveSelection();
      if (!this.#isCurrent(requestEpoch)) {
        return;
      }

      if (selection !== null) {
        await this.#showSelectionAndTranslate(requestId, selection, requestEpoch, surface);
        return;
      }

      // 選択取得の失敗時に既存のクリップボードを使うと、無関係な過去の文章を
      // 翻訳してしまう。クリップボードの読み取りは明示的な翻訳操作に限定する。
      throw new Error('Selection was unavailable.');
    } catch (error) {
      if (!this.#isCurrent(requestEpoch)) {
        return;
      }

      const message =
        error instanceof SelectionTextTooLargeError
          ? '選択範囲が長すぎます。範囲を短くしてください。'
          : '選択を取得できませんでした。';
      this.#logger.warn('Selection request failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      this.#clearActiveSession();
      if (surface === 'popup') this.#popup.showError(requestId, message);
      else this.#popup.showErrorInMain(requestId, message);
      this.#publishStatus();
    }
  }

  #triggerSelectionFromHotkey(): void {
    // Windows may repeat WM_HOTKEY while the chord remains physically held。選択取得から翻訳完了
    // までを1回の押下として保持し、同じrequestを反復callbackで置き換えない。
    if (this.#hotkeyTriggerActive || this.#activeSurface === 'popup' || this.#popup.isVisible)
      return;
    this.#hotkeyTriggerActive = true;
    this.#observeBackground(
      this.triggerSelection().finally(() => {
        this.#hotkeyTriggerActive = false;
      }),
      'Hotkey translation request escaped its error boundary',
    );
  }

  async triggerClipboard(): Promise<void> {
    const requestEpoch = this.#beginRequest();
    this.#clearActiveSession();
    this.#activeSurface = 'popup';
    const requestId = randomUUID();
    this.#popup.showCapturing(requestId, null);
    this.#registerPopupDismissHotkey();
    this.#publishStatus();
    await nextTurn();
    if (!this.#isCurrent(requestEpoch)) {
      return;
    }

    try {
      await this.#showClipboardOrManual(requestId, requestEpoch);
    } catch (error) {
      if (!this.#isCurrent(requestEpoch)) {
        return;
      }
      this.#logger.warn('Clipboard request failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      this.#clearActiveSession();
      this.#popup.showManual(requestId, null);
      this.#publishStatus();
    }
  }

  useManualText(input: string): void {
    const text = this.#validatedSourceText(input);
    const requestId = randomUUID();
    const requestEpoch = this.#beginRequest();

    if (text === null) {
      this.#clearActiveSession();
      this.#popup.showManual(requestId, null);
      this.#publishStatus();
      return;
    }

    const selection: ResolvedSelection = {
      text,
      programName: null,
      method: 'manual',
      anchor: null,
      acquiredAt: Date.now(),
    };
    this.#observeBackground(
      this.#showSelectionAndTranslate(requestId, selection, requestEpoch, 'popup'),
      'Manual translation request escaped its error boundary',
    );
  }

  translateTextInMain(
    input: string,
    conversationDirection: 'incoming' | 'outgoing' | null = null,
    writingStyle: WritingStyleInstruction | null = null,
    inlineContextsInput: readonly string[] = [],
    appliedInstructionsInput: readonly AppliedTranslationInstruction[] = [],
    targetLanguage: string | null = null,
    conversationContext: readonly ConversationContextTurn[] = [],
    conversationSessionId: string | null = null,
  ): void {
    const text = this.#validatedSourceText(input);
    if (text === null) return;
    const inlineContexts = this.#validatedInlineContexts(inlineContextsInput);
    const appliedInstructions = this.#validatedAppliedInstructions(
      appliedInstructionsInput,
      inlineContexts,
      writingStyle,
    );
    if (conversationDirection === 'incoming' && this.#settings.snapshot.nativeLanguage === null) {
      throw new Error('会話翻訳には母国語の設定が必要です。');
    }

    // Mainから開始した翻訳が、開いたままのPopupに操作可能な古い結果を残さないよう閉じる。
    this.#hotkey.unregisterTransient(POPUP_DISMISS_HOTKEY);
    this.#popup.hide();
    const requestId = randomUUID();
    const requestEpoch = this.#beginRequest();
    this.#mainConversationDirection = conversationDirection;
    const selection: ResolvedSelection = {
      text,
      programName: null,
      method: 'manual',
      anchor: null,
      acquiredAt: Date.now(),
    };
    this.#observeBackground(
      this.#showSelectionAndTranslate(
        requestId,
        selection,
        requestEpoch,
        'main',
        writingStyle,
        inlineContexts,
        appliedInstructions,
        targetLanguage,
        conversationContext,
        conversationSessionId,
      ),
      'Main translation request escaped its error boundary',
    );
  }

  async retryTranslation(requester: TranslationSurface | null = null): Promise<void> {
    const selection = this.#activeSelection;
    if (
      !this.#ownsActiveSurface(requester) ||
      selection === null ||
      this.#activeSurface === null ||
      this.#activeRequestAbortController !== null
    ) {
      return;
    }

    const operation = this.#lastTranslationOperation;
    const writingStyle = this.#lastWritingStyle;
    const currentResult = this.#activeTranslationResult;
    if (operation !== 'translate' && currentResult === null) {
      return;
    }
    const requestEpoch = this.#beginRequest();
    const requestId = randomUUID();
    this.#popup.beginTranslationOperation(requestId, operation, currentResult, writingStyle?.name);
    const abortController = this.#startProviderRequest();
    await nextTurn();
    await this.#streamTranslation(
      requestId,
      selection,
      requestEpoch,
      operation,
      currentResult,
      abortController,
      writingStyle,
    );
  }

  async applyTranslationAction(
    action: TranslationActionOperation,
    requester: TranslationSurface | null = null,
    baseTranslation?: string,
  ): Promise<void> {
    const selection = this.#activeSelection;
    const currentResult = this.#operationBaseResult(baseTranslation);
    if (
      !this.#ownsActiveSurface(requester) ||
      selection === null ||
      currentResult === null ||
      this.#activeSurface === null ||
      this.#activeRequestAbortController !== null
    ) {
      return;
    }

    const requestEpoch = this.#beginRequest();
    const requestId = randomUUID();
    this.#lastTranslationOperation = action;
    this.#lastWritingStyle = null;
    this.#popup.beginTranslationOperation(requestId, action, currentResult);
    const abortController = this.#startProviderRequest();
    await nextTurn();
    await this.#streamTranslation(
      requestId,
      selection,
      requestEpoch,
      action,
      currentResult,
      abortController,
    );
  }

  async applyWritingStyle(
    styleId: string,
    requester: TranslationSurface | null = null,
    baseTranslation?: string,
  ): Promise<void> {
    const selection = this.#activeSelection;
    const currentResult = this.#operationBaseResult(baseTranslation);
    const style = this.#settings.snapshot.writingStyles.find(
      (candidate) =>
        candidate.id === styleId && candidate.hidden !== true && candidate.deleted !== true,
    );
    if (
      !this.#ownsActiveSurface(requester) ||
      selection === null ||
      currentResult === null ||
      style === undefined ||
      this.#activeSurface === null ||
      this.#activeRequestAbortController !== null
    ) {
      return;
    }

    const requestEpoch = this.#beginRequest();
    const requestId = randomUUID();
    this.#lastTranslationOperation = 'writing-style';
    this.#lastWritingStyle = style;
    this.#popup.beginTranslationOperation(requestId, 'writing-style', currentResult, style.name);
    const abortController = this.#startProviderRequest();
    await nextTurn();
    await this.#streamTranslation(
      requestId,
      selection,
      requestEpoch,
      'writing-style',
      currentResult,
      abortController,
      style,
    );
  }

  async sendFollowUp(input: string, requester: TranslationSurface | null = null): Promise<void> {
    const question = this.#validatedFollowUpText(input);
    const selection = this.#activeSelection;
    const translation = this.#activeTranslationResult;
    if (
      !this.#ownsActiveSurface(requester) ||
      question === null ||
      selection === null ||
      translation === null ||
      this.#activeSurface === null ||
      this.#activeRequestAbortController !== null
    ) {
      return;
    }

    const requestEpoch = this.#beginRequest();
    const requestId = randomUUID();
    this.#lastFailedFollowUp = null;
    this.#popup.showFollowUpStarted(requestId, question);
    const abortController = this.#startProviderRequest();
    await nextTurn();
    if (!this.#isCurrent(requestEpoch)) {
      return;
    }

    const request: FollowUpRequest = {
      requestId,
      sourceText: selection.text,
      translation,
      messages: this.#followUpMessages,
      question,
      ...(this.#settings.snapshot.nativeLanguage === null
        ? {}
        : { responseLanguage: this.#settings.snapshot.nativeLanguage }),
      signal: abortController.signal,
    };

    try {
      for await (const event of this.#followUp.ask(request)) {
        if (
          !this.#isCurrent(requestEpoch) ||
          abortController.signal.aborted ||
          event.requestId !== requestId
        ) {
          return;
        }
        this.#popup.showFollowUpEvent(event);
        if (event.type === 'completed') {
          const completedMessages: FollowUpMessage[] = [
            ...this.#followUpMessages,
            { role: 'user', text: question },
            { role: 'assistant', text: event.text },
          ];
          this.#followUpMessages = completedMessages.slice(-40);
          this.#recordFollowUp(question, event.text, event.completedAt);
        } else if (event.type === 'failed') {
          this.#lastFailedFollowUp = question;
        }
      }
    } catch (error) {
      if (!this.#isCurrent(requestEpoch) || abortController.signal.aborted) {
        return;
      }
      this.#logger.error('Follow-up service escaped its error boundary', error);
      this.#lastFailedFollowUp = question;
      this.#popup.showFollowUpEvent({
        type: 'failed',
        requestId,
        code: 'unknown',
        message: '回答できませんでした。',
        retryable: true,
      });
    } finally {
      if (this.#activeRequestAbortController === abortController) {
        this.#activeRequestAbortController = null;
      }
    }
  }

  async retryFollowUp(requester: TranslationSurface | null = null): Promise<void> {
    const question = this.#lastFailedFollowUp;
    if (question !== null && this.#ownsActiveSurface(requester)) {
      await this.sendFollowUp(question, requester);
    }
  }

  async copyText(text: string): Promise<void> {
    const validated = this.#validatedClipboardText(text);
    if (validated !== null) {
      await this.#clipboard.writeText(validated);
    }
  }

  resizePopup(request: PopupResizeRequest): void {
    this.#popup.resize(request);
  }

  get settings(): SettingsSnapshot {
    return this.#settings.snapshot;
  }

  beginShortcutCapture(): void {
    if (this.#disposed || this.#shortcutCaptureActive) {
      return;
    }
    this.#hotkey.suspend();
    this.#shortcutCaptureActive = true;
  }

  endShortcutCapture(): void {
    if (!this.#shortcutCaptureActive) {
      return;
    }
    this.#shortcutCaptureActive = false;
    this.#hotkey.resume();
  }

  updateShortcut(shortcut: string): ShortcutUpdateResult {
    const previousAccelerator = this.#hotkeyAccelerator;
    const previousState = this.#hotkeyState;
    const registration = this.#hotkey.register(shortcut, () => this.#triggerSelectionFromHotkey());
    if (registration.state === 'registered' || registration.state === 'disabled') {
      try {
        this.#settings.setShortcut(registration.accelerator);
      } catch (error) {
        const rollback = this.#hotkey.register(previousAccelerator, () =>
          this.#triggerSelectionFromHotkey(),
        );
        this.#hotkeyAccelerator = previousAccelerator;
        this.#hotkeyState =
          rollback.state === 'registered' || rollback.state === 'disabled'
            ? previousState
            : rollback.state;
        this.#publishStatus();
        if (rollback.state !== 'registered' && rollback.state !== 'disabled') {
          throw new AggregateError(
            [error, new Error('The previous global shortcut could not be restored.')],
            'ショートカットの保存と復元に失敗しました。',
          );
        }
        throw error;
      }
      this.#hotkeyAccelerator = registration.accelerator;
      this.#hotkeyState = registration.state;
      this.#publishStatus();
      return {
        state: registration.state,
        shortcut: registration.accelerator,
        message: null,
      };
    }

    return {
      state: registration.state,
      shortcut: registration.accelerator,
      message:
        registration.state === 'conflict'
          ? 'このショートカットは他のアプリで使用されています。'
          : 'このキーの組み合わせは登録できません。',
    };
  }

  updateGeneralSettings(update: GeneralSettingsUpdate): SettingsSnapshot {
    return this.#settings.updateGeneral(update);
  }

  fetchProviderModels(request: FetchProviderModelsRequest): Promise<readonly ProviderModel[]> {
    return this.#settings.fetchModels(request);
  }

  async loginChatGpt(providerId: string): Promise<void> {
    try {
      await this.#settings.loginChatGpt(providerId);
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      // OAuth応答にはtokenが含まれる可能性があるため、ログには型とcodeだけを残す。
      this.#logger.warn('ChatGPT login failed', {
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode:
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
        causeName: cause instanceof Error ? cause.name : typeof cause,
        causeCode:
          typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined,
      });
      throw error;
    }
  }

  saveProvider(request: SaveProviderRequest): SettingsSnapshot {
    this.#prepareProviderChange();
    return this.#settings.saveProvider(request);
  }

  deleteProvider(providerId: string): SettingsSnapshot {
    this.#prepareProviderChange();
    return this.#settings.deleteProvider(providerId);
  }

  updateUsedModels(request: UpdateUsedModelsRequest): SettingsSnapshot {
    this.#prepareProviderChange();
    return this.#settings.updateUsedModels(request);
  }

  listHistory(query: HistoryQuery): readonly HistoryListItem[] {
    // 常駐中でも履歴を開くタイミングで期限を再評価する。起動時だけの整理では、
    // 長期間常駐したアプリに期限切れデータが残り続けるためである。
    this.#applyHistoryRetention(this.#settings.snapshot);
    return this.#history.list(query.query, query.limit);
  }

  getHistoryDetail(historyId: string): HistoryDetail | null {
    return this.#history.get(historyId);
  }

  deleteHistory(historyId: string): void {
    this.#history.delete(historyId);
    this.#mainWindow.sendHistoryChanged();
  }

  clearHistory(): void {
    this.#history.clear();
    this.#mainWindow.sendHistoryChanged();
  }

  closePopup(): void {
    if (this.#activeSurface === 'popup') {
      this.#invalidateRequest();
      this.#clearActiveSession();
    }
    this.#hotkey.unregisterTransient(POPUP_DISMISS_HOTKEY);
    this.#popup.hide();
    this.#publishStatus();
  }

  showMainWindow(): void {
    this.#mainWindow.show();
  }

  #ownsActiveSurface(requester: TranslationSurface | null): boolean {
    return requester === null || requester === this.#activeSurface;
  }

  dispose(): Promise<void> {
    if (this.#disposal !== null) {
      return this.#disposal;
    }

    this.#disposed = true;
    this.#disposal = this.#disposeResources();
    return this.#disposal;
  }

  async #disposeResources(): Promise<void> {
    const errors: unknown[] = [];
    const cleanup = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    };

    this.#invalidateRequest();
    this.#clearActiveSession();

    // Native startup may itself be the await that initialization is blocked on.
    // Begin stop first, then let initialization observe #disposed and unwind.
    let selectionStop: Promise<void> = Promise.resolve();
    try {
      selectionStop = this.#selection.stop();
    } catch (error) {
      errors.push(error);
    }
    await this.#initialization?.catch(() => undefined);

    cleanup(() => this.#removeMouseDownListener?.());
    this.#removeMouseDownListener = null;
    cleanup(() => this.#removeSettingsListener?.());
    this.#removeSettingsListener = null;
    cleanup(() => this.#hotkey.unregisterTransient(POPUP_DISMISS_HOTKEY));
    if (this.#shortcutCaptureActive) {
      this.#shortcutCaptureActive = false;
      try {
        this.#hotkey.resume();
      } catch (error) {
        this.#logger.warn('Global shortcuts could not be resumed during shutdown', { error });
      }
    }
    cleanup(() => this.#hotkey.dispose());
    cleanup(() => this.#popup.setDismissHandler(null));
    cleanup(() => this.#popup.dispose());
    cleanup(() => this.#mainWindow.dispose());
    try {
      await selectionStop;
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more application resources could not be disposed.');
    }
  }

  async #showClipboardOrManual(
    requestId: string,
    requestEpoch: number,
    surface: TranslationSurface = 'popup',
  ): Promise<void> {
    const clipboardText = this.#validatedSourceText(await this.#clipboard.readText());
    if (!this.#isCurrent(requestEpoch)) {
      return;
    }
    if (clipboardText === null) {
      this.#clearActiveSession();
      if (surface === 'popup') this.#popup.showManual(requestId, null);
      this.#publishStatus();
      return;
    }

    const selection: ResolvedSelection = {
      text: clipboardText,
      programName: null,
      method: 'clipboard-current',
      anchor: null,
      acquiredAt: Date.now(),
    };
    await this.#showSelectionAndTranslate(requestId, selection, requestEpoch, surface);
  }

  async #showSelectionAndTranslate(
    requestId: string,
    selection: ResolvedSelection,
    requestEpoch: number,
    surface: 'popup' | 'main' = 'popup',
    writingStyle: WritingStyleInstruction | null = null,
    inlineContexts: readonly string[] = [],
    appliedInstructions: readonly AppliedTranslationInstruction[] = [],
    targetLanguage: string | null = null,
    conversationContext: readonly ConversationContextTurn[] = [],
    conversationSessionId: string | null = null,
  ): Promise<void> {
    if (!this.#isCurrent(requestEpoch)) {
      return;
    }

    this.#activeSelection = selection;
    this.#activeSurface = surface;
    if (surface === 'popup') this.#mainConversationDirection = null;
    this.#activeTranslationResult = null;
    this.#lastTranslationOperation = 'translate';
    this.#lastWritingStyle = writingStyle;
    this.#lastInlineContexts = inlineContexts;
    this.#lastAppliedInstructions = appliedInstructions;
    this.#lastRequestedTargetLanguage = targetLanguage;
    this.#mainConversationContext = conversationContext;
    this.#followUpMessages = [];
    this.#lastFailedFollowUp = null;
    // 通常翻訳は従来どおり毎回独立させる。会話翻訳だけRendererが所有するIDを
    // 再利用し、返信ごとにサイドバー項目が分裂しないよう一つの履歴へまとめる。
    this.#activeHistorySessionId = conversationSessionId ?? randomUUID();
    this.#historyHasTranslation = false;
    // Session開始時に履歴OFFなら、その後ONへ切り替わっても同じPopup sessionは
    // 永続化しない。途中操作だけの不可視session/orphanを作らないための境界である。
    this.#historyRecordingEligible = this.#settings.snapshot.historyEnabled;
    if (surface === 'main') {
      this.#popup.showSelectionInMain(requestId, selection);
      // 選択本文はすでに退避済みなので、ここからは結果画面を通常どおり前面に出せる。
      this.#mainWindow.show();
    } else {
      this.#popup.showSelection(requestId, selection);
    }
    this.#publishStatus();
    const abortController = this.#startProviderRequest();

    // MainからPopup stateを先に送り、Rendererへpaint機会を渡してからProviderを開始する。
    // 翻訳完了を待たず、sourceとskeletonが即座に見えるUXを守るための順序である。
    await nextTurn();
    if (!this.#isCurrent(requestEpoch)) {
      return;
    }

    await this.#streamTranslation(
      requestId,
      selection,
      requestEpoch,
      'translate',
      null,
      abortController,
      writingStyle,
    );
  }

  async #streamTranslation(
    requestId: string,
    selection: ResolvedSelection,
    requestEpoch: number,
    operation: TranslationOperation,
    currentResult: TranslationResult | null,
    abortController: AbortController,
    writingStyle: WritingStyleInstruction | null = null,
  ): Promise<void> {
    if (!this.#isCurrent(requestEpoch)) {
      return;
    }

    const request: TranslationRequest = {
      requestId,
      sourceText: selection.text,
      operation,
      // 翻訳先が英語でも、解説と候補のニュアンスはユーザーの母国語で返す。
      ...(this.#settings.snapshot.nativeLanguage === null
        ? {}
        : { explanationLanguage: this.#settings.snapshot.nativeLanguage }),
      // 翻訳先は三分岐にする。言語検出はProviderに任せるが、
      // ルール自体は構造化データとして固定しsourceText内の指示と分離する。
      ...(operation === 'translate' && this.#lastRequestedTargetLanguage !== null
        ? { targetLanguage: this.#lastRequestedTargetLanguage }
        : operation === 'translate' && this.#mainConversationDirection === 'outgoing'
          ? { targetLanguage: 'English' }
          : operation === 'translate' &&
              this.#mainConversationDirection === 'incoming' &&
              this.#settings.snapshot.nativeLanguage !== null
            ? { targetLanguage: this.#settings.snapshot.nativeLanguage }
            : operation === 'translate' && this.#settings.snapshot.nativeLanguage !== null
              ? {
                  languageRouting: {
                    nativeLanguage: this.#settings.snapshot.nativeLanguage,
                    otherLanguageTarget: this.#settings.snapshot.otherLanguageTarget,
                  },
                }
              : {}),
      ...(writingStyle === null
        ? {}
        : { writingStyle: { name: writingStyle.name, instruction: writingStyle.instruction } }),
      ...(operation === 'back-translate' || this.#lastInlineContexts.length === 0
        ? {}
        : { inlineContexts: this.#lastInlineContexts }),
      ...(operation !== 'translate' || this.#mainConversationContext.length === 0
        ? {}
        : { conversationContext: this.#mainConversationContext }),
      ...(operation === 'translate'
        ? { translationStyle: this.#settings.snapshot.translationStyle }
        : {}),
      ...(currentResult === null ? {} : { currentResult }),
      ...(this.#settings.snapshot.developerMode && this.#settings.snapshot.debugMode
        ? { debugMode: true }
        : {}),
      signal: abortController.signal,
    };

    try {
      for await (const event of this.#translation.translate(request)) {
        if (
          !this.#isCurrent(requestEpoch) ||
          abortController.signal.aborted ||
          event.requestId !== requestId
        ) {
          return;
        }
        if (event.type === 'completed' && operation !== 'back-translate') {
          this.#activeTranslationResult = event.value;
        }
        if (event.type === 'completed') {
          this.#recordTranslation(
            requestId,
            selection,
            operation,
            event.value,
            event.completedAt,
            writingStyle?.name,
          );
        }
        this.#popup.showTranslationEvent(event);
      }
    } catch (error) {
      if (!this.#isCurrent(requestEpoch) || abortController.signal.aborted) {
        return;
      }
      this.#logger.error('Translation service escaped its error boundary', error);
      this.#popup.showTranslationEvent({
        type: 'failed',
        requestId,
        code: 'unknown',
        message: '翻訳できませんでした。',
        retryable: true,
      });
    } finally {
      if (this.#activeRequestAbortController === abortController) {
        this.#activeRequestAbortController = null;
      }
    }
  }

  #validatedFollowUpText(input: string): string | null {
    const text = input.replaceAll('\u0000', '').trim();
    if (text.length === 0) {
      return null;
    }
    const maximumCodePoints = 5_000;
    if (
      text.length > maximumCodePoints * 2 ||
      (text.length > maximumCodePoints && Array.from(text).length > maximumCodePoints)
    ) {
      return null;
    }
    return text;
  }

  #operationBaseResult(baseTranslation: string | undefined): TranslationResult | null {
    const currentResult = this.#activeTranslationResult;
    if (currentResult === null || baseTranslation === undefined) return currentResult;

    // 別案の操作でも言語方向と説明コンテキストは元の翻訳結果から引き継ぎ、
    // Providerへ送る操作対象の本文だけを、ユーザーが選んだ別案へ差し替える。
    const validatedTranslation = this.#validatedSourceText(baseTranslation);
    if (validatedTranslation === null) return null;
    return { ...currentResult, translation: validatedTranslation };
  }

  #validatedInlineContexts(input: readonly string[]): readonly string[] {
    const result = validateInlineTranslationContexts(input);
    if (!result.success) {
      throw new Error(
        result.error === 'too-many' ? '翻訳用の文脈が多すぎます。' : '翻訳用の文脈が長すぎます。',
      );
    }
    return result.value;
  }

  #validatedAppliedInstructions(
    input: readonly AppliedTranslationInstruction[],
    inlineContexts: readonly string[],
    writingStyle: WritingStyleInstruction | null,
  ): readonly AppliedTranslationInstruction[] {
    // 古いPreloadや直接呼び出すテストでも履歴表示が空にならないよう、表示専用snapshotが
    // 未指定の場合だけControllerが安全に再構成する。Rendererから来た場合は追加指示本文を保つ。
    const source =
      input.length > 0
        ? input
        : [
            ...inlineContexts.map((label): AppliedTranslationInstruction => ({
              kind: 'context',
              label,
            })),
            ...(writingStyle === null
              ? []
              : ([
                  { kind: 'writing-style', label: writingStyle.name },
                ] satisfies readonly AppliedTranslationInstruction[])),
          ];
    return source.slice(0, MAX_APPLIED_TRANSLATION_INSTRUCTIONS).flatMap((instruction) => {
      const label = normalizeAppliedTranslationInstructionLabel(instruction.label);
      return label.length === 0 ? [] : [{ kind: instruction.kind, label }];
    });
  }

  #clearActiveSession(): void {
    this.#activeSelection = null;
    this.#activeTranslationResult = null;
    this.#lastTranslationOperation = 'translate';
    this.#lastWritingStyle = null;
    this.#lastInlineContexts = [];
    this.#lastAppliedInstructions = [];
    this.#lastRequestedTargetLanguage = null;
    this.#mainConversationContext = [];
    this.#followUpMessages = [];
    this.#lastFailedFollowUp = null;
    this.#activeHistorySessionId = null;
    this.#historyHasTranslation = false;
    this.#historyRecordingEligible = false;
    this.#activeSurface = null;
    this.#mainConversationDirection = null;
  }

  #applyHistoryRetention(settings: SettingsSnapshot): void {
    const days = settings.historyRetentionDays;
    if (days === null) return;
    try {
      const deleted = this.#history.purgeOlderThan(Date.now() - days * 24 * 60 * 60 * 1_000);
      if (deleted > 0) this.#mainWindow.sendHistoryChanged();
    } catch (error) {
      // 保持期間の整理に失敗しても翻訳・履歴閲覧は継続する。次回起動または設定変更時に再試行する。
      this.#logger.warn('Expired translation history could not be removed', { error });
    }
  }

  #validatedSourceText(input: string | null): string | null {
    return this.#validatedText(input, MAX_TRANSLATION_SOURCE_CODE_POINTS);
  }

  #validatedClipboardText(input: string | null): string | null {
    // Provider results are validated separately and can legitimately be longer
    // than source input. Keep copying independent from the translation request cap.
    return this.#validatedText(input, MAX_CLIPBOARD_TEXT_CODE_POINTS);
  }

  #validatedText(input: string | null, maximumCodePoints: number): string | null {
    if (input === null) {
      return null;
    }

    const text = input.replaceAll('\u0000', '').trim();
    if (text.length === 0) {
      return null;
    }

    if (
      text.length > maximumCodePoints * 2 ||
      (text.length > maximumCodePoints && Array.from(text).length > maximumCodePoints)
    ) {
      throw new SelectionTextTooLargeError(maximumCodePoints);
    }

    return text;
  }

  #observeBackground(operation: Promise<void>, message: string): void {
    // The main process treats unhandled rejections as fatal. User-triggered work has
    // its own recovery paths, but failures escaping those boundaries must stay observable.
    void operation.catch((error: unknown) => {
      this.#logger.error(message, error);
    });
  }

  #isCurrent(epoch: number): boolean {
    return !this.#disposed && epoch === this.#requestEpoch;
  }

  #beginRequest(): number {
    this.#activeRequestAbortController?.abort();
    this.#activeRequestAbortController = null;
    this.#requestEpoch += 1;
    return this.#requestEpoch;
  }

  #startProviderRequest(): AbortController {
    // IPC連打で次のevent-loop turn前に別操作が到着しても、一つ目を勝者として固定する。
    // Hotkeyによる新しい選択だけは#beginRequestを通るため、明示的に現在処理を置き換えられる。
    if (this.#activeRequestAbortController !== null) {
      throw new Error('A provider request is already active.');
    }
    const abortController = new AbortController();
    this.#activeRequestAbortController = abortController;
    return abortController;
  }

  #invalidateRequest(): void {
    this.#activeRequestAbortController?.abort();
    this.#activeRequestAbortController = null;
    this.#requestEpoch += 1;
  }

  #publishStatus(): void {
    this.#mainWindow.sendStatus(this.status);
  }

  #recordTranslation(
    requestId: string,
    selection: ResolvedSelection,
    operation: TranslationOperation,
    result: TranslationResult,
    createdAt: number,
    writingStyleName?: string,
  ): void {
    const sessionId = this.#activeHistorySessionId;
    const completedModel = this.#providers.consumeCompletedModel(requestId);
    if (
      sessionId === null ||
      !this.#historyRecordingEligible ||
      !this.#settings.snapshot.historyEnabled
    ) {
      return;
    }
    try {
      this.#history.recordTranslation({
        sessionId,
        requestId,
        selection,
        operation,
        ...(this.#mainConversationDirection === null
          ? {}
          : { conversationDirection: this.#mainConversationDirection }),
        ...(writingStyleName === undefined ? {} : { writingStyleName }),
        ...(operation === 'back-translate' || this.#lastAppliedInstructions.length === 0
          ? {}
          : { appliedInstructions: this.#lastAppliedInstructions }),
        result,
        providerProfileId: completedModel?.providerId ?? null,
        providerName: completedModel?.providerName ?? null,
        modelId: completedModel?.modelId ?? null,
        createdAt,
      });
      this.#historyHasTranslation = true;
      this.#mainWindow.sendHistoryChanged();
    } catch (error) {
      // 履歴保存失敗で翻訳結果そのものを失わせない。DB障害はlogへ隔離する。
      this.#logger.error('Translation history could not be saved', error);
    }
  }

  #recordFollowUp(question: string, answer: string, createdAt: number): void {
    const sessionId = this.#activeHistorySessionId;
    const selection = this.#activeSelection;
    if (
      sessionId === null ||
      selection === null ||
      !this.#historyHasTranslation ||
      !this.#historyRecordingEligible ||
      !this.#settings.snapshot.historyEnabled
    ) {
      return;
    }
    try {
      this.#history.recordFollowUp({
        sessionId,
        selection,
        question,
        answer,
        createdAt,
      });
      this.#mainWindow.sendHistoryChanged();
    } catch (error) {
      this.#logger.error('Follow-up history could not be saved', error);
    }
  }

  #prepareProviderChange(): void {
    if (this.#popup.isVisible) {
      this.closePopup();
      return;
    }
    this.#invalidateRequest();
  }

  #registerPopupDismissHotkey(): void {
    this.#hotkey.registerTransient(POPUP_DISMISS_HOTKEY, () => {
      if (this.#popup.isVisible) {
        this.closePopup();
      }
    });
  }
}
