import { join } from 'node:path';
import { app, BrowserWindow, desktopCapturer, screen } from 'electron';
import type { WebContents } from 'electron';
import log from 'electron-log/main';
import type { Rectangle, ScreenCaptureSelection } from '../../../shared/contracts';
import { trustedRendererUrl } from '../../ipc-sender-policy';

export interface CapturedScreenRegion {
  /** 選択範囲を物理pixelで切り出したPNG。 */
  readonly png: Buffer;
  /** 選択範囲のscreen座標（DIP）。Popupを範囲の近くに出すために使う。 */
  readonly rect: Rectangle;
}

export interface ScreenRegionCaptureService {
  /**
   * 範囲選択overlayを表示し、ユーザーが選んだ範囲の画像を返す。
   * Esc・右クリック・極小範囲などの取消ではnullを返す。
   * すでに選択中に再度呼ばれた場合は、新しいoverlayを出さずnullを返す。
   */
  capture(): Promise<CapturedScreenRegion | null>;
  /** overlay rendererからの応答を受け取る。現在のoverlay以外のsenderからの応答は無視する。 */
  complete(sender: WebContents, selection: ScreenCaptureSelection | null): void;
  dispose(): void;
}

const logger = log.scope('screen-region-capture');
const FOCUS_LOSS_CANCEL_DELAY_MS = 1_000;
const OVERLAY_DISMISS_DELAY_MS = 50;
const MINIMUM_SELECTION_DIP = 4;

async function loadOverlayRenderer(
  window: BrowserWindow,
  rendererUrl: string | undefined,
): Promise<void> {
  if (rendererUrl !== undefined) {
    const url = new URL(rendererUrl);
    url.searchParams.set('window', 'screen-capture');
    await window.loadURL(url.toString());
    return;
  }

  await window.loadFile(join(__dirname, '../renderer/index.html'), {
    query: { window: 'screen-capture' },
  });
}

function normalizeSelection(
  selection: ScreenCaptureSelection,
  displayBounds: Rectangle,
): Rectangle | null {
  if (
    !Number.isFinite(selection.x) ||
    !Number.isFinite(selection.y) ||
    !Number.isFinite(selection.width) ||
    !Number.isFinite(selection.height) ||
    selection.width < MINIMUM_SELECTION_DIP ||
    selection.height < MINIMUM_SELECTION_DIP
  ) {
    return null;
  }

  // 画面端でドラッグを終えると、pointer captureの座標がwindow外になることがある。
  // 画像と返却rectを一致させるため、pixel換算より先にDIP範囲をdisplay内へ切り詰める。
  const left = Math.max(0, Math.min(selection.x, displayBounds.width));
  const top = Math.max(0, Math.min(selection.y, displayBounds.height));
  const right = Math.max(0, Math.min(selection.x + selection.width, displayBounds.width));
  const bottom = Math.max(0, Math.min(selection.y + selection.height, displayBounds.height));
  if (right - left < MINIMUM_SELECTION_DIP || bottom - top < MINIMUM_SELECTION_DIP) {
    return null;
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function createScreenRegionCaptureService(
  rendererUrl: string | undefined = trustedRendererUrl(
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
  ),
): ScreenRegionCaptureService {
  let captureInProgress = false;
  let disposed = false;
  let overlay: BrowserWindow | null = null;
  let finishSelection: ((selection: ScreenCaptureSelection | null) => void) | null = null;
  let cancelActiveCapture: (() => void) | null = null;

  return {
    async capture(): Promise<CapturedScreenRegion | null> {
      if (disposed || captureInProgress) return null;
      captureInProgress = true;

      let resolveCancellation: (() => void) | null = null;
      const cancelled = new Promise<null>((resolve) => {
        resolveCancellation = () => resolve(null);
      });
      cancelActiveCapture = () => resolveCancellation?.();

      try {
        const captureTask = (async (): Promise<CapturedScreenRegion | null> => {
          try {
            // 画面全体を一度に扱うと、displayごとのscaleFactorや座標原点を混ぜてしまう。
            // 現状はカーソルのあるdisplayだけをoverlayと画像の両方に使う。
            const cursorPoint = screen.getCursorScreenPoint();
            const display = screen.getDisplayNearestPoint(cursorPoint);
            const selection = await new Promise<ScreenCaptureSelection | null>((resolve) => {
              const window = new BrowserWindow({
                x: display.bounds.x,
                y: display.bounds.y,
                width: display.bounds.width,
                height: display.bounds.height,
                show: false,
                frame: false,
                transparent: true,
                backgroundColor: '#00000000',
                resizable: false,
                maximizable: false,
                minimizable: false,
                fullscreenable: false,
                skipTaskbar: true,
                focusable: true,
                hasShadow: false,
                webPreferences: {
                  preload: join(__dirname, '../preload/index.js'),
                  contextIsolation: true,
                  nodeIntegration: false,
                  sandbox: true,
                  spellcheck: false,
                },
              });

              overlay = window;
              let settled = false;
              let hasBeenFocused = false;
              let focusLossTimer: ReturnType<typeof setTimeout> | null = null;
              const finish = (result: ScreenCaptureSelection | null): void => {
                if (settled) return;
                settled = true;
                if (focusLossTimer !== null) clearTimeout(focusLossTimer);
                focusLossTimer = null;

                if (overlay === window) overlay = null;
                if (finishSelection === finish) finishSelection = null;

                // 透明overlay自身がdesktopCapturerの画像に写らないよう、選択結果を解決する前に
                // hide/destroyする。capture側はさらに短く待ってから実画面を取得する。
                if (!window.isDestroyed()) {
                  window.hide();
                  window.destroy();
                }
                resolve(result);
              };

              finishSelection = finish;
              window.once('closed', () => finish(null));
              window.on('focus', () => {
                hasBeenFocused = true;
                if (focusLossTimer !== null) clearTimeout(focusLossTimer);
                focusLossTimer = null;
              });
              window.on('blur', () => {
                if (!hasBeenFocused || !window.isVisible() || focusLossTimer !== null) return;
                focusLossTimer = setTimeout(() => finish(null), FOCUS_LOSS_CANCEL_DELAY_MS);
              });
              window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
              window.webContents.on('will-navigate', (event) => event.preventDefault());

              window.setAlwaysOnTop(true, 'screen-saver');
              // Rendererの入力処理が準備できる前に表示すると、最初のドラッグやEscを
              // 取りこぼす可能性があるため、読み込み完了後に表示してfocusを渡す。
              void loadOverlayRenderer(window, rendererUrl)
                .then(() => {
                  if (settled || disposed || window.isDestroyed()) return;
                  window.show();
                  window.focus();
                  window.moveTop();
                })
                .catch((error: unknown) => {
                  if (settled) return;
                  logger.error('Failed to load screen capture overlay', error);
                  finish(null);
                });
            });

            if (selection === null || disposed) return null;
            const clippedSelection = normalizeSelection(selection, display.bounds);
            if (clippedSelection === null) return null;

            // Windowsではhide直後のframeに透明overlayが残ることがある。
            // 短く待ち、overlayが消えた後の実画面を取得する。
            await new Promise<void>((resolve) => setTimeout(resolve, OVERLAY_DISMISS_DELAY_MS));
            if (disposed) return null;

            const pixelSize = {
              width: Math.round(display.bounds.width * display.scaleFactor),
              height: Math.round(display.bounds.height * display.scaleFactor),
            };
            const sources = await desktopCapturer.getSources({
              types: ['screen'],
              thumbnailSize: pixelSize,
            });
            if (disposed) return null;

            const source =
              sources.find((candidate) => candidate.display_id === String(display.id)) ??
              sources[0];
            if (source === undefined) {
              logger.warn('No screen source was available for screenshot capture', {
                displayId: display.id,
              });
              return null;
            }
            if (source.display_id !== String(display.id)) {
              logger.warn(
                'Screen source did not identify the cursor display; using the first source',
                {
                  displayId: display.id,
                  sourceDisplayId: source.display_id,
                },
              );
            }

            const thumbnail = source.thumbnail;
            const thumbnailSize = thumbnail.getSize();
            const imageScaleX = thumbnailSize.width / pixelSize.width;
            const imageScaleY = thumbnailSize.height / pixelSize.height;
            if (thumbnailSize.width <= 0 || thumbnailSize.height <= 0) return null;
            // Display boundsとoverlay座標はDIPだがNativeImage.cropはpixelを受け取る。
            // 要求thumbnail寸法と実寸が異なる場合もあるため、実画像への比率を重ねて換算する。
            // 端数pixelは外側へ丸め、選択範囲を欠けさせない。
            const cropLeft = Math.max(
              0,
              Math.floor(clippedSelection.x * display.scaleFactor * imageScaleX),
            );
            const cropTop = Math.max(
              0,
              Math.floor(clippedSelection.y * display.scaleFactor * imageScaleY),
            );
            const cropRight = Math.min(
              thumbnailSize.width,
              Math.ceil(
                (clippedSelection.x + clippedSelection.width) * display.scaleFactor * imageScaleX,
              ),
            );
            const cropBottom = Math.min(
              thumbnailSize.height,
              Math.ceil(
                (clippedSelection.y + clippedSelection.height) * display.scaleFactor * imageScaleY,
              ),
            );
            if (cropRight <= cropLeft || cropBottom <= cropTop) return null;

            const png = thumbnail
              .crop({
                x: cropLeft,
                y: cropTop,
                width: cropRight - cropLeft,
                height: cropBottom - cropTop,
              })
              .toPNG();
            if (png.byteLength === 0) return null;

            return {
              png,
              rect: {
                x: display.bounds.x + clippedSelection.x,
                y: display.bounds.y + clippedSelection.y,
                width: clippedSelection.width,
                height: clippedSelection.height,
              },
            };
          } catch (error) {
            logger.error('Failed to capture selected screen region', error);
            return null;
          }
        })();

        return await Promise.race([captureTask, cancelled]);
      } finally {
        if (cancelActiveCapture !== null) cancelActiveCapture = null;
        resolveCancellation = null;
        finishSelection?.(null);
        const window = overlay;
        overlay = null;
        if (window !== null && !window.isDestroyed()) {
          window.hide();
          window.destroy();
        }
        captureInProgress = false;
      }
    },

    complete(sender, selection) {
      const window = overlay;
      if (window === null || sender !== window.webContents) return;
      finishSelection?.(selection);
    },

    dispose() {
      disposed = true;
      cancelActiveCapture?.();
      cancelActiveCapture = null;
      finishSelection?.(null);
      const window = overlay;
      overlay = null;
      if (window !== null && !window.isDestroyed()) {
        window.hide();
        window.destroy();
      }
    },
  };
}
