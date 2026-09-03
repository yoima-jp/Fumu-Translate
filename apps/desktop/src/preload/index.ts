import { contextBridge, ipcRenderer } from 'electron';
import type { ConversationContextTurn } from '@fumu/translation-core';
import type {
  DesktopStatus,
  FumuDesktopApi,
  PopupResizeRequest,
  PopupViewState,
} from '../shared/contracts';
import type { HistoryDetail, HistoryListItem, HistoryQuery } from '../shared/history-contracts';
import type {
  GeneralSettingsUpdate,
  FetchProviderModelsRequest,
  SaveProviderRequest,
  SettingsSnapshot,
} from '../shared/settings-contracts';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { AppliedTranslationInstruction } from '../shared/applied-translation-instructions-contract';

const api: FumuDesktopApi = {
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.appGetStatus),
  triggerClipboard: () => ipcRenderer.invoke(IPC_CHANNELS.appTriggerClipboard),
  restartApp: () => ipcRenderer.invoke(IPC_CHANNELS.appRestart),
  openLanguageSettings: () => ipcRenderer.invoke(IPC_CHANNELS.appOpenLanguageSettings),
  translateText: (
    text: string,
    conversationDirection = null,
    writingStyle = null,
    inlineContexts: readonly string[] = [],
    appliedInstructions: readonly AppliedTranslationInstruction[] = [],
    targetLanguage: string | null = null,
    conversationContext: readonly ConversationContextTurn[] = [],
    conversationSessionId: string | null = null,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.appTranslateText,
      text,
      conversationDirection,
      writingStyle,
      inlineContexts,
      appliedInstructions,
      targetLanguage,
      conversationContext,
      conversationSessionId,
    ),
  closePopup: () => ipcRenderer.invoke(IPC_CHANNELS.popupClose),
  copyText: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.popupCopy, text),
  useManualText: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.popupUseManual, text),
  retryTranslation: () => ipcRenderer.invoke(IPC_CHANNELS.popupRetryTranslation),
  applyTranslationAction: (action, baseTranslation) =>
    ipcRenderer.invoke(IPC_CHANNELS.popupApplyTranslationAction, action, baseTranslation),
  applyWritingStyle: (styleId, baseTranslation) =>
    ipcRenderer.invoke(IPC_CHANNELS.popupApplyWritingStyle, styleId, baseTranslation),
  sendFollowUp: (question) => ipcRenderer.invoke(IPC_CHANNELS.popupSendFollowUp, question),
  retryFollowUp: () => ipcRenderer.invoke(IPC_CHANNELS.popupRetryFollowUp),
  resizePopup: (request: PopupResizeRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.popupResize, request),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  beginShortcutCapture: () => ipcRenderer.invoke(IPC_CHANNELS.settingsBeginShortcutCapture),
  endShortcutCapture: () => ipcRenderer.invoke(IPC_CHANNELS.settingsEndShortcutCapture),
  updateShortcut: (shortcut) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdateShortcut, shortcut),
  updateGeneralSettings: (update: GeneralSettingsUpdate) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsUpdateGeneral, update),
  fetchProviderModels: (request: FetchProviderModelsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsFetchProviderModels, request),
  loginChatGpt: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.settingsLoginChatGpt, providerId),
  saveProvider: (request: SaveProviderRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsSaveProvider, request),
  deleteProvider: (providerId) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsDeleteProvider, providerId),
  updateUsedModels: (request) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdateUsedModels, request),
  listHistory: (query: HistoryQuery): Promise<readonly HistoryListItem[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.historyList, query),
  getHistoryDetail: (historyId: string): Promise<HistoryDetail | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.historyGet, historyId),
  deleteHistory: (historyId) => ipcRenderer.invoke(IPC_CHANNELS.historyDelete, historyId),
  clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.historyClear),
  onPopupState: (listener: (state: PopupViewState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: PopupViewState): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.popupStateChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.popupStateChanged, wrapped);
    };
  },
  onStatus: (listener: (status: DesktopStatus) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: DesktopStatus): void => {
      listener(status);
    };
    ipcRenderer.on(IPC_CHANNELS.appStatusChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.appStatusChanged, wrapped);
    };
  },
  onSettingsChanged: (listener: (settings: SettingsSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, settings: SettingsSnapshot): void => {
      listener(settings);
    };
    ipcRenderer.on(IPC_CHANNELS.settingsChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.settingsChanged, wrapped);
    };
  },
  onHistoryChanged: (listener: () => void) => {
    const wrapped = (): void => {
      listener();
    };
    ipcRenderer.on(IPC_CHANNELS.historyChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.historyChanged, wrapped);
    };
  },
};

// Channel名やipcRenderer自体は渡さず、画面が必要とする操作だけを固定APIとして公開する。
contextBridge.exposeInMainWorld('fumu', api);
