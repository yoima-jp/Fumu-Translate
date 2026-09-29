import type { WebContents } from 'electron';
import type { Rectangle, ScreenCaptureSelection } from '../../../shared/contracts';

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

export function createScreenRegionCaptureService(): ScreenRegionCaptureService {
  // 実装前の仮実装。常に取消として扱う。
  return {
    capture: () => Promise.resolve(null),
    complete: () => undefined,
    dispose: () => undefined,
  };
}
