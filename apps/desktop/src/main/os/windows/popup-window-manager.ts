import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import log from 'electron-log/main';
import type {
  FollowUpEvent,
  TranslationEvent,
  TranslationOperation,
  TranslationResult,
} from '@fumu/translation-core';
import type {
  Point,
  PopupResizeRequest,
  PopupViewState,
  Rectangle,
  ResolvedSelection,
  SelectionAnchor,
} from '../../../shared/contracts';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { startFollowUpMessages } from '../../follow-up-view-state';
import {
  applyTranslationViewEvent,
  beginTranslationViewOperation,
  initialTranslationViewState,
} from '../../translation-view-state';
import { calculatePopupBounds, workAreaCenter, type Size } from './popup-position';
import { WindowsCaretLocator } from './windows-caret-locator';

const INITIAL_SIZE: Size = { width: 480, height: 248 };
const SELECTION_SIZE: Size = { width: 480, height: 560 };
const MANUAL_SIZE: Size = { width: 480, height: 312 };
const MINIMUM_SIZE: Size = { width: 360, height: 180 };
const MAXIMUM_SIZE: Size = { width: 620, height: 760 };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export class PopupWindowManager {
  readonly #logger = log.scope('popup-window');
  #window: BrowserWindow | null = null;
  #popupState: PopupViewState = { phase: 'idle', requestId: null };
  #mainState: PopupViewState = { phase: 'idle', requestId: null };
  #activeSurface: 'popup' | 'main' | null = null;
  #anchor: SelectionAnchor | null = null;
  #size: Size = INITIAL_SIZE;
  #disposing = false;
  #hasBeenFocused = false;
  #dismissHandler: (() => void) | null = null;

  constructor(
    readonly rendererUrl: string | undefined,
    readonly caretLocator = new WindowsCaretLocator(),
    readonly stateListener: ((state: PopupViewState) => void) | null = null,
  ) {}

  get isVisible(): boolean {
    return this.#window?.isVisible() ?? false;
  }

  setDismissHandler(handler: (() => void) | null): void {
    this.#dismissHandler = handler;
  }

  async initialize(): Promise<void> {
    if (this.#window !== null) {
      return;
    }

    const window = new BrowserWindow({
      title: 'Fumu!',
      width: INITIAL_SIZE.width,
      height: INITIAL_SIZE.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: true,
      roundedCorners: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    // Rendererから外部URLや任意Windowを開かせない。
    // PopupはLocal Bundleだけを描画し、Provider通信はMain Processへ閉じる。
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });

    window.on('close', (event) => {
      if (this.#disposing) {
        return;
      }

      event.preventDefault();
      this.#dismissHandler?.();
    });

    window.on('focus', () => {
      this.#hasBeenFocused = true;
    });

    window.on('blur', () => {
      // showInactive直後の疑似的なblurでは閉じない。
      // 一度PopupへFocusが移った後だけ、通常のWindow blurを外側操作として扱う。
      if (this.#hasBeenFocused && window.isVisible() && window.isFocusable()) {
        // Controllerを経由してProviderのabortと一時Escape登録の解除も同時に行う。
        // Windowだけを隠すと、非表示のrequestが更新を続けるため直接hideしない。
        this.#dismissHandler?.();
      }
    });

    this.#window = window;
    await this.#loadRenderer(window, 'popup');
    window.webContents.send(IPC_CHANNELS.popupStateChanged, this.#popupState);
  }

  showCapturing(requestId: string, preferredAnchor: SelectionAnchor | null): void {
    const window = this.#requiredWindow();
    this.#activeSurface = 'popup';
    this.#popupState = { phase: 'capturing', requestId };
    this.#anchor = this.#toDipAnchor(this.#translationAnchor(preferredAnchor));
    this.#size = INITIAL_SIZE;
    this.#hasBeenFocused = false;

    window.setFocusable(false);
    this.#applyBounds();
    this.#logger.debug('Capturing popup positioned', {
      anchorKind: this.#anchor.kind,
      bounds: window.getBounds(),
    });
    this.#sendPopupState();
    window.showInactive();
    window.moveTop();
  }

  showSelection(requestId: string, selection: ResolvedSelection): void {
    const window = this.#requiredWindow();
    this.#activeSurface = 'popup';
    this.#popupState = {
      phase: 'selection',
      requestId,
      selection,
      translation: initialTranslationViewState(),
      followUpMessages: [],
    };
    // Clipboard fallback中は一時的にCaretが消えるアプリがある。
    // 選択結果が新しい位置を持たないときは、即時表示で確定したanchorを維持して
    // PopupがMouse cursorへ飛ぶのを防ぐ。
    if (selection.anchor !== null || this.#anchor === null) {
      this.#anchor = this.#toDipAnchor(this.#translationAnchor(selection.anchor));
    }
    this.#size = SELECTION_SIZE;

    this.#applyBounds();
    this.#logger.debug('Selection popup positioned', {
      anchorKind: this.#anchor.kind,
      bounds: window.getBounds(),
      selectionMethod: selection.method,
    });
    this.#sendPopupState();
    // Selection acquisition is complete. Move focus now so keyboard-only and
    // screen-reader users can immediately reach copy, transform, and follow-up
    // controls; the capturing skeleton deliberately kept the source app focused.
    this.#showInteractive(window);
  }

  showSelectionInMain(requestId: string, selection: ResolvedSelection): void {
    this.#activeSurface = 'main';
    this.#mainState = {
      phase: 'selection',
      requestId,
      selection,
      translation: initialTranslationViewState(),
      followUpMessages: [],
    };
    this.#sendMainState();
  }

  beginTranslationOperation(
    requestId: string,
    operation: TranslationOperation,
    previousValue: TranslationResult | null,
    writingStyleName?: string,
  ): void {
    const state = this.#activeState();
    if (state.phase !== 'selection') {
      return;
    }

    this.#setActiveState({
      ...state,
      requestId,
      translation: beginTranslationViewOperation(
        state.translation,
        operation,
        previousValue,
        writingStyleName,
      ),
    });
    this.#sendActiveState();
  }

  showTranslationEvent(event: TranslationEvent): void {
    const state = this.#activeState();
    if (state.phase !== 'selection' || state.requestId !== event.requestId) {
      return;
    }

    if (event.type === 'cancelled') return;
    this.#setActiveState({
      ...state,
      translation: applyTranslationViewEvent(state.translation, event),
    });

    this.#sendActiveState();
  }

  showFollowUpStarted(requestId: string, question: string): void {
    const state = this.#activeState();
    if (state.phase !== 'selection') {
      return;
    }

    this.#setActiveState({
      ...state,
      followUpMessages: startFollowUpMessages(state.followUpMessages, requestId, question),
    });
    this.#sendActiveState();
  }

  showFollowUpEvent(event: FollowUpEvent): void {
    const state = this.#activeState();
    if (state.phase !== 'selection' || event.type === 'started') {
      return;
    }

    const messages = state.followUpMessages.map((message) => {
      if (message.role !== 'assistant' || message.id !== event.requestId) {
        return message;
      }

      switch (event.type) {
        case 'snapshot':
          return { ...message, phase: 'streaming' as const, text: event.text };
        case 'completed':
          return { ...message, phase: 'completed' as const, text: event.text };
        case 'failed':
          return {
            ...message,
            phase: 'failed' as const,
            errorMessage: event.message,
            retryable: event.retryable,
          };
        case 'cancelled':
          return {
            ...message,
            phase: 'failed' as const,
            errorMessage: '中断しました。',
            retryable: false,
          };
      }
    });
    this.#setActiveState({ ...state, followUpMessages: messages });
    this.#sendActiveState();
  }

  showManual(requestId: string, clipboardText: string | null): void {
    const window = this.#requiredWindow();
    this.#activeSurface = 'popup';
    this.#popupState = { phase: 'manual', requestId, clipboardText };
    this.#anchor = this.#toDipAnchor(this.#cursorOrScreenCenterAnchor());
    this.#size = MANUAL_SIZE;

    this.#applyBounds();
    this.#sendPopupState();
    this.#showInteractive(window);
  }

  showError(requestId: string, message: string): void {
    const window = this.#requiredWindow();
    this.#activeSurface = 'popup';
    this.#popupState = { phase: 'error', requestId, message };
    this.#size = MANUAL_SIZE;
    this.#applyBounds();
    this.#sendPopupState();
    this.#showInteractive(window);
  }

  resize(request: PopupResizeRequest): void {
    if (!Number.isFinite(request.width) || !Number.isFinite(request.height)) {
      return;
    }

    this.#size = {
      width: clamp(Math.round(request.width), MINIMUM_SIZE.width, MAXIMUM_SIZE.width),
      height: clamp(Math.round(request.height), MINIMUM_SIZE.height, MAXIMUM_SIZE.height),
    };
    this.#applyBounds();
  }

  containsPhysicalPoint(point: Point): boolean {
    const window = this.#window;
    if (window === null || !window.isVisible()) {
      return false;
    }

    const dipPoint = screen.screenToDipPoint(point);
    const bounds = window.getBounds();
    return (
      dipPoint.x >= bounds.x &&
      dipPoint.x < bounds.x + bounds.width &&
      dipPoint.y >= bounds.y &&
      dipPoint.y < bounds.y + bounds.height
    );
  }

  hide(): void {
    const window = this.#window;
    if (window === null) {
      return;
    }

    window.setFocusable(false);
    window.hide();
    this.#hasBeenFocused = false;
    this.#popupState = { phase: 'idle', requestId: null };
    if (this.#activeSurface === 'popup') this.#activeSurface = null;
    this.#anchor = null;
    this.#size = INITIAL_SIZE;
    this.#sendPopupState();
  }

  dispose(): void {
    const window = this.#window;
    this.#window = null;
    this.#disposing = true;
    this.#dismissHandler = null;
    if (window !== null && !window.isDestroyed()) {
      window.destroy();
    }
  }

  #applyBounds(): void {
    const window = this.#window;
    const anchor = this.#anchor;
    if (window === null || anchor === null) {
      return;
    }

    const point = this.#anchorPoint(anchor);
    const display = screen.getDisplayNearestPoint(point);
    const workArea: Rectangle = display.workArea;
    const bounds = calculatePopupBounds(anchor, this.#size, workArea);
    window.setBounds(bounds, false);
  }

  #activeState(): PopupViewState {
    return this.#activeSurface === 'main' ? this.#mainState : this.#popupState;
  }

  #setActiveState(state: PopupViewState): void {
    if (this.#activeSurface === 'main') this.#mainState = state;
    else this.#popupState = state;
  }

  #sendActiveState(): void {
    if (this.#activeSurface === 'main') this.#sendMainState();
    else this.#sendPopupState();
  }

  #sendMainState(): void {
    this.stateListener?.(this.#mainState);
  }

  #sendPopupState(): void {
    const window = this.#window;
    if (window === null || window.isDestroyed() || window.webContents.isLoading()) {
      return;
    }

    window.webContents.send(IPC_CHANNELS.popupStateChanged, this.#popupState);
  }

  #requiredWindow(): BrowserWindow {
    if (this.#window === null || this.#window.isDestroyed()) {
      throw new Error('Popup window has not been initialized.');
    }

    return this.#window;
  }

  #showInteractive(window: BrowserWindow): void {
    window.setFocusable(true);
    if (!window.isVisible()) {
      window.show();
    }
    window.focus();
    window.moveTop();
  }

  #translationAnchor(preferred: SelectionAnchor | null): SelectionAnchor {
    if (preferred?.kind === 'selection' || preferred?.kind === 'caret') {
      return preferred;
    }

    // 選択Rectが取れない場合だけ標準Win32 Caretを問い合わせる。
    // Chromeなど独自Caretのアプリではnullとなり、Selection終端のMouse座標へ進む。
    const caret = this.caretLocator.locate();
    if (caret !== null) {
      return caret;
    }

    if (preferred !== null) {
      return preferred;
    }

    return this.#cursorOrScreenCenterAnchor();
  }

  #cursorOrScreenCenterAnchor(): SelectionAnchor {
    const cursor = screen.getCursorScreenPoint();
    if (Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
      return {
        kind: 'cursor',
        point: cursor,
      };
    }

    return {
      kind: 'screen-center',
      point: workAreaCenter(screen.getPrimaryDisplay().workArea),
    };
  }

  #toDipAnchor(anchor: SelectionAnchor): SelectionAnchor {
    if (anchor.kind === 'cursor' || anchor.kind === 'screen-center') {
      return anchor;
    }

    if (anchor.kind === 'mouse') {
      return {
        kind: 'mouse',
        point: screen.screenToDipPoint(anchor.point),
      };
    }

    const topLeft = screen.screenToDipPoint({ x: anchor.rect.x, y: anchor.rect.y });
    const bottomRight = screen.screenToDipPoint({
      x: anchor.rect.x + anchor.rect.width,
      y: anchor.rect.y + anchor.rect.height,
    });
    return {
      kind: anchor.kind,
      rect: {
        x: topLeft.x,
        y: topLeft.y,
        width: Math.max(1, bottomRight.x - topLeft.x),
        height: Math.max(1, bottomRight.y - topLeft.y),
      },
    };
  }

  #anchorPoint(anchor: SelectionAnchor): Point {
    if (anchor.kind === 'selection' || anchor.kind === 'caret') {
      return {
        x: anchor.rect.x + anchor.rect.width,
        y: anchor.rect.y + anchor.rect.height,
      };
    }

    return anchor.point;
  }

  async #loadRenderer(window: BrowserWindow, windowKind: 'popup'): Promise<void> {
    if (this.rendererUrl !== undefined) {
      const url = new URL(this.rendererUrl);
      url.searchParams.set('window', windowKind);
      await window.loadURL(url.toString());
      return;
    }

    await window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: windowKind },
    });
  }

  showAtScreenCenterForDiagnostics(requestId: string): void {
    const primaryWorkArea = screen.getPrimaryDisplay().workArea;
    this.#anchor = {
      kind: 'screen-center',
      point: workAreaCenter(primaryWorkArea),
    };
    this.showError(requestId, '選択を取得できませんでした。');
  }
}
