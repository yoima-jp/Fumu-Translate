import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@fumu/i18n';

export interface TrayActions {
  readonly showMainWindow: () => void;
  readonly translateClipboard: () => void;
  readonly quit: () => void;
}

// 通知領域の文言カタログ。Electron MenuのlabelはOSリソースに依存しないため、
// 表示言語はこのカタログだけで完結する。
interface TrayMenuLabels {
  readonly open: string;
  readonly translateClipboard: string;
  readonly quit: string;
}

const TRAY_LABELS: Readonly<Record<UiLocale, TrayMenuLabels>> = Object.freeze({
  en: Object.freeze({
    open: 'Open Fumu!',
    translateClipboard: 'Translate Clipboard',
    quit: 'Quit',
  }),
  ja: Object.freeze({
    open: 'Fumu!を開く',
    translateClipboard: 'クリップボードを翻訳',
    quit: '終了',
  }),
});

export function trayLabels(locale: UiLocale): TrayMenuLabels {
  return TRAY_LABELS[locale];
}

function trayImage() {
  // 16pxの通知領域でも目と芽が判別できるよう、メインキャラクターの形を
  // 添付アセットから簡略化する。Data URLなら開発版と配布版で同じ表示になる。
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<path d="M17 7c0-3 1-5 3-7 1 3 0 6-2 8M18 7c3-2 6-2 9-1-2 2-5 3-9 2M17 7c-2-3-4-4-7-5 1 3 3 5 6 6" fill="#80df37"/>',
    '<rect x="2" y="7" width="28" height="24" rx="8.5" fill="#75dd35"/>',
    '<path d="M8 16h6v3c0 2-1.2 3.5-3 3.5S8 21 8 19zM18 16h6v3c0 2-1.2 3.5-3 3.5S18 21 18 19z" fill="#fff"/>',
    '<rect x="8" y="15" width="6" height="3" rx="1" fill="#0a5338"/>',
    '<rect x="18" y="15" width="6" height="3" rx="1" fill="#0a5338"/>',
    '<rect x="15" y="24" width="2" height="1.5" rx=".75" fill="#0a5338"/>',
    '</svg>',
  ].join('');
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return nativeImage.createFromDataURL(dataUrl).resize({ width: 16, height: 16 });
}

export function createTrayMenuTemplate(
  actions: TrayActions,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): MenuItemConstructorOptions[] {
  const labels = trayLabels(locale);
  return [
    { label: labels.open, click: actions.showMainWindow },
    { label: labels.translateClipboard, click: actions.translateClipboard },
    { type: 'separator' },
    { label: labels.quit, click: actions.quit },
  ];
}

export class TrayManager {
  readonly #actions: TrayActions;
  #tray: Tray | null = null;
  #locale: UiLocale;

  constructor(actions: TrayActions, locale: UiLocale = DEFAULT_UI_LOCALE) {
    this.#actions = actions;
    this.#locale = locale;
  }

  /** 母国語設定の変更を動的に反映する。未初期化なら次のinitializeで使われる。 */
  setLocale(locale: UiLocale): void {
    this.#locale = locale;
    if (this.#tray !== null) {
      this.#tray.setContextMenu(
        Menu.buildFromTemplate(createTrayMenuTemplate(this.#actions, locale)),
      );
    }
  }

  initialize(): void {
    if (this.#tray !== null) {
      return;
    }
    const tray = new Tray(trayImage());
    tray.setToolTip('Fumu!');
    tray.setContextMenu(
      Menu.buildFromTemplate(createTrayMenuTemplate(this.#actions, this.#locale)),
    );
    tray.on('click', this.#actions.showMainWindow);
    this.#tray = tray;
  }

  dispose(): void {
    this.#tray?.destroy();
    this.#tray = null;
  }
}
