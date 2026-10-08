import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import type { DesktopStatus, PopupViewState } from '../../../shared/contracts';
import type { SettingsSnapshot } from '../../../shared/settings-contracts';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

const MAIN_WINDOW_HIDE_SETTLE_MS = 200;

export class MainWindowManager {
  #window: BrowserWindow | null = null;
  #disposing = false;

  constructor(
    readonly rendererUrl: string | undefined,
    readonly initiallyVisible = true,
  ) {}

  async initialize(): Promise<void> {
    if (this.#window !== null) {
      return;
    }

    const window = new BrowserWindow({
      title: 'Fumu!',
      width: 960,
      height: 680,
      minWidth: 420,
      minHeight: 540,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#f5f1e9',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
      },
    });

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    window.on('close', (event) => {
      if (this.#disposing) {
        return;
      }
      // 常駐翻訳を止めず、一般的なTrayアプリと同じく×は非表示として扱う。
      event.preventDefault();
      window.hide();
    });

    this.#window = window;
    await this.#loadRenderer(window);
    // Login startup should establish Hotkey and Tray services without covering
    // the user's desktop. Explicit launch keeps the normal first-run window.
    if (this.initiallyVisible) {
      window.show();
    }
  }

  sendStatus(status: DesktopStatus): void {
    const window = this.#window;
    if (window === null || window.isDestroyed() || window.webContents.isLoading()) {
      return;
    }

    window.webContents.send(IPC_CHANNELS.appStatusChanged, status);
  }

  sendSettings(settings: SettingsSnapshot): void {
    const window = this.#window;
    if (window === null || window.isDestroyed() || window.webContents.isLoading()) {
      return;
    }
    window.webContents.send(IPC_CHANNELS.settingsChanged, settings);
  }

  sendHistoryChanged(): void {
    const window = this.#window;
    if (window === null || window.isDestroyed() || window.webContents.isLoading()) {
      return;
    }
    window.webContents.send(IPC_CHANNELS.historyChanged);
  }

  sendPopupState(state: PopupViewState): void {
    const window = this.#window;
    if (window === null || window.isDestroyed() || window.webContents.isLoading()) return;
    window.webContents.send(IPC_CHANNELS.popupStateChanged, state);
  }

  show(): void {
    const window = this.#window;
    if (window === null || window.isDestroyed()) {
      return;
    }

    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }

  showInactive(): void {
    const window = this.#window;
    if (window === null || window.isDestroyed()) {
      return;
    }

    // Hotkeyを押したアプリの選択状態を保ったまま、翻訳先の画面だけを表示する。
    // 選択取得後もユーザーが明示的に触れるまでは元アプリへ入力を続けられる。
    window.showInactive();
  }

  async hide(): Promise<void> {
    const window = this.#window;
    if (window === null || window.isDestroyed() || !window.isVisible()) return;
    window.hide();
    // Windowsはhide後も閉じるアニメーションの数frameが画面に残り、直後の撮影に写り込む。
    // 実測で100ms前後かかるため、余裕を見て待ってから呼び出し元へ返す。
    await new Promise<void>((resolve) => setTimeout(resolve, MAIN_WINDOW_HIDE_SETTLE_MS));
  }

  dispose(): void {
    this.#disposing = true;
    const window = this.#window;
    this.#window = null;
    if (window !== null && !window.isDestroyed()) {
      window.destroy();
    }
  }

  async #loadRenderer(window: BrowserWindow): Promise<void> {
    if (this.rendererUrl !== undefined) {
      const url = new URL(this.rendererUrl);
      url.searchParams.set('window', 'main');
      await window.loadURL(url.toString());
      return;
    }

    await window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'main' },
    });
  }
}
