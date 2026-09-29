import type {
  ConversationContextTurn,
  TranslationActionOperation,
  TranslationErrorCode,
  TranslationOperation,
  TranslationResult,
  TranslationSnapshot,
} from '@fumu/translation-core';
import type { HistoryDetail, HistoryListItem, HistoryQuery } from './history-contracts';
import type {
  GeneralSettingsUpdate,
  FetchProviderModelsRequest,
  ProviderModel,
  SaveProviderRequest,
  SettingsSnapshot,
  ScreenshotShortcutUpdateResult,
  ShortcutUpdateResult,
  UpdateUsedModelsRequest,
  WritingStyleInstruction,
} from './settings-contracts';
import type { AppliedTranslationInstruction } from './applied-translation-instructions-contract';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const SELECTION_METHOD_VALUES = [
  'uia',
  'accessible',
  'clipboard-copy',
  'clipboard-current',
  'manual',
  // スクリーンショット翻訳で、画面の範囲を画像として読み取り文字起こししたもの。
  'screenshot',
  'unknown',
] as const;
export type SelectionMethod = (typeof SELECTION_METHOD_VALUES)[number];

export type SelectionAnchor =
  | {
      readonly kind: 'selection';
      readonly rect: Rectangle;
    }
  | {
      readonly kind: 'mouse';
      readonly point: Point;
    }
  | {
      readonly kind: 'caret';
      readonly rect: Rectangle;
    }
  | {
      readonly kind: 'cursor';
      readonly point: Point;
    }
  | {
      readonly kind: 'screen-center';
      readonly point: Point;
    };

export interface ResolvedSelection {
  readonly text: string;
  readonly programName: string | null;
  readonly method: SelectionMethod;
  readonly anchor: SelectionAnchor | null;
  readonly acquiredAt: number;
}

export interface TranslationCardView {
  readonly operation: Exclude<TranslationOperation, 'back-translate'>;
  readonly value: TranslationResult;
  readonly writingStyleName?: string;
}

export type TranslationViewState =
  | {
      readonly phase: 'loading';
      readonly operation: TranslationOperation;
      readonly writingStyleName?: string;
      readonly previousValue: TranslationResult | null;
      readonly cards: readonly TranslationCardView[];
    }
  | {
      readonly phase: 'streaming';
      readonly operation: TranslationOperation;
      readonly writingStyleName?: string;
      readonly previousValue: TranslationResult | null;
      readonly sequence: number;
      readonly value: TranslationSnapshot;
      readonly cards: readonly TranslationCardView[];
    }
  | {
      readonly phase: 'completed';
      readonly operation: TranslationOperation;
      readonly writingStyleName?: string;
      readonly value: TranslationResult;
      readonly previousValue: TranslationResult | null;
      readonly cards: readonly TranslationCardView[];
    }
  | {
      readonly phase: 'failed';
      readonly code: TranslationErrorCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly lastSnapshot: TranslationSnapshot | null;
      readonly debugResponse?: string;
      readonly operation: TranslationOperation;
      readonly writingStyleName?: string;
      readonly previousValue: TranslationResult | null;
      readonly cards: readonly TranslationCardView[];
    };

export type FollowUpMessageView =
  | {
      readonly id: string;
      readonly role: 'user';
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly role: 'assistant';
      readonly phase: 'loading' | 'streaming' | 'completed' | 'failed';
      readonly text: string;
      readonly errorMessage: string | null;
      readonly retryable: boolean;
    };

export type PopupErrorMessageKey =
  | 'popup.selectionError'
  | 'popup.selectionTooLarge'
  | 'popup.imageReadError'
  | 'popup.screenReadError'
  | 'main.imageNoText'
  | 'main.imageOcrUnavailable'
  | 'main.imageTextTooLong';

export type PopupViewState =
  | {
      readonly phase: 'idle';
      readonly requestId: string | null;
    }
  | {
      readonly phase: 'capturing';
      readonly requestId: string;
    }
  | {
      readonly phase: 'selection';
      readonly requestId: string;
      readonly selection: ResolvedSelection;
      readonly translation: TranslationViewState;
      readonly followUpMessages: readonly FollowUpMessageView[];
    }
  | {
      readonly phase: 'manual';
      readonly requestId: string;
      readonly clipboardText: string | null;
    }
  | {
      readonly phase: 'error';
      readonly requestId: string;
      readonly message: string;
      readonly messageKey?: PopupErrorMessageKey;
      readonly action?: 'open-clipboard' | 'retry-image-with-model';
    };

export type HotkeyRegistrationState = 'registered' | 'conflict' | 'invalid' | 'disabled';

export interface DesktopStatus {
  readonly hotkey: string;
  readonly hotkeyState: HotkeyRegistrationState;
  readonly screenshotHotkeyState: HotkeyRegistrationState;
  readonly selectionServiceRunning: boolean;
  readonly popupVisible: boolean;
  readonly activeProviderName: string | null;
  readonly activeModelName: string | null;
  readonly translationConfigured: boolean;
}

/**
 * rendererからmainへ渡す画像。rendererはブラウザで復号できる形式（WebP/GIF/BMPなど）を
 * PNGへ変換してから渡す。mainはサイズ検証・縮小・再エンコードを一か所で行う。
 */
export interface ImageInputPayload {
  readonly mediaType: 'image/png' | 'image/jpeg';
  readonly data: Uint8Array;
}

export type ImageTextExtractionErrorCode =
  | TranslationErrorCode
  /** 復号できない、または空の画像。 */
  | 'invalid-image'
  /** 入力バイト数の上限を超えた画像。 */
  | 'image-too-large';

export type ImageTextExtractionOutcome =
  | { readonly status: 'completed'; readonly text: string }
  | { readonly status: 'no-text' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'failed';
      readonly code: ImageTextExtractionErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    };

export type ImageTextExtractionMode = 'configured' | 'model';

/** スクリーンショット範囲選択overlay内の座標（DIP、overlay windowの左上基準）。 */
export interface ScreenCaptureSelection {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PopupResizeRequest {
  readonly width: number;
  readonly height: number;
}

export interface FumuDesktopApi {
  checkUpdates(): Promise<import('./update-contracts').UpdateStatus>;
  downloadUpdate(): Promise<boolean>;
  getStatus(): Promise<DesktopStatus>;
  triggerClipboard(): Promise<void>;
  restartApp(): Promise<void>;
  openLanguageSettings(): Promise<void>;
  translateText(
    text: string,
    conversationDirection?: 'incoming' | 'outgoing' | null,
    writingStyle?: WritingStyleInstruction | null,
    inlineContexts?: readonly string[],
    appliedInstructions?: readonly AppliedTranslationInstruction[],
    targetLanguage?: string | null,
    conversationContext?: readonly ConversationContextTurn[],
    conversationSessionId?: string | null,
  ): Promise<void>;
  closePopup(): Promise<void>;
  copyText(text: string): Promise<void>;
  useManualText(text: string): Promise<void>;
  retryTranslation(): Promise<void>;
  applyTranslationAction(
    action: TranslationActionOperation,
    baseTranslation?: string,
  ): Promise<void>;
  applyWritingStyle(styleId: string, baseTranslation?: string): Promise<void>;
  sendFollowUp(question: string): Promise<void>;
  retryFollowUp(): Promise<void>;
  resizePopup(request: PopupResizeRequest): Promise<void>;
  getSettings(): Promise<SettingsSnapshot>;
  beginShortcutCapture(): Promise<void>;
  endShortcutCapture(): Promise<void>;
  updateShortcut(shortcut: string): Promise<ShortcutUpdateResult>;
  /** nullでスクリーンショット翻訳を無効化する。 */
  updateScreenshotShortcut(shortcut: string | null): Promise<ScreenshotShortcutUpdateResult>;
  /** メインウィンドウに貼り付け・ドロップされた画像の文字を書き起こす。翻訳はしない。 */
  extractImageText(
    image: ImageInputPayload,
    mode?: ImageTextExtractionMode,
  ): Promise<ImageTextExtractionOutcome>;
  /** 実行中の画像読み取りを中断する。読み取り中でなければ何もしない。 */
  cancelImageTextExtraction(): Promise<void>;
  /** スクリーンショット範囲選択overlayから、選択範囲（nullは取消）を返す。 */
  completeScreenCapture(selection: ScreenCaptureSelection | null): Promise<void>;
  /** 端末OCRで読めなかった直前のスクリーンショットを、明示操作でAIモデルへ送る。 */
  retryScreenCaptureWithModel(): Promise<void>;
  updateGeneralSettings(update: GeneralSettingsUpdate): Promise<SettingsSnapshot>;
  fetchProviderModels(request: FetchProviderModelsRequest): Promise<readonly ProviderModel[]>;
  loginChatGpt(providerId: string): Promise<void>;
  saveProvider(request: SaveProviderRequest): Promise<SettingsSnapshot>;
  deleteProvider(providerId: string): Promise<SettingsSnapshot>;
  updateUsedModels(request: UpdateUsedModelsRequest): Promise<SettingsSnapshot>;
  listHistory(query: HistoryQuery): Promise<readonly HistoryListItem[]>;
  getHistoryDetail(historyId: string): Promise<HistoryDetail | null>;
  deleteHistory(historyId: string): Promise<void>;
  clearHistory(): Promise<void>;
  onPopupState(listener: (state: PopupViewState) => void): () => void;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  onSettingsChanged(listener: (settings: SettingsSnapshot) => void): () => void;
  onHistoryChanged(listener: () => void): () => void;
}
