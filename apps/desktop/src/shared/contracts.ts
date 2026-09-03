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
    };

export type HotkeyRegistrationState = 'registered' | 'conflict' | 'invalid' | 'disabled';

export interface DesktopStatus {
  readonly hotkey: string;
  readonly hotkeyState: HotkeyRegistrationState;
  readonly selectionServiceRunning: boolean;
  readonly popupVisible: boolean;
  readonly activeProviderName: string | null;
  readonly activeModelName: string | null;
  readonly translationConfigured: boolean;
}

export interface PopupResizeRequest {
  readonly width: number;
  readonly height: number;
}

export interface FumuDesktopApi {
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
