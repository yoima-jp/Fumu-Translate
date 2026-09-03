import log from 'electron-log/main';
import * as koffi from 'koffi';
import type { Rectangle, SelectionAnchor } from '../../../shared/contracts';

interface NativeRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface GuiThreadInfo {
  cbSize: number;
  flags: number;
  hwndActive: unknown;
  hwndFocus: unknown;
  hwndCapture: unknown;
  hwndMenuOwner: unknown;
  hwndMoveSize: unknown;
  hwndCaret: unknown;
  rcCaret: NativeRectangle;
}

export interface WindowsCaretNativeApi {
  readonly structureSize: number;
  getForegroundGuiThreadInfo(info: GuiThreadInfo): boolean;
  mapCaretRectangleToScreen(hwndCaret: unknown, rectangle: NativeRectangle): void;
}

function createNativeApi(): WindowsCaretNativeApi | null {
  if (process.platform !== 'win32') {
    return null;
  }

  const rectangleType = koffi.struct('FumuWin32Rect', {
    left: 'int32',
    top: 'int32',
    right: 'int32',
    bottom: 'int32',
  });
  const guiThreadInfoType = koffi.struct('FumuGuiThreadInfo', {
    cbSize: 'uint32',
    flags: 'uint32',
    hwndActive: 'void *',
    hwndFocus: 'void *',
    hwndCapture: 'void *',
    hwndMenuOwner: 'void *',
    hwndMoveSize: 'void *',
    hwndCaret: 'void *',
    rcCaret: rectangleType,
  });
  const user32 = koffi.load('user32.dll');
  const getGuiThreadInfo = user32.func('__stdcall', 'GetGUIThreadInfo', 'bool', [
    'uint32',
    koffi.inout(koffi.pointer(guiThreadInfoType)),
  ]) as (threadId: number, info: GuiThreadInfo) => boolean;
  const mapWindowPoints = user32.func('__stdcall', 'MapWindowPoints', 'int32', [
    'void *',
    'void *',
    koffi.inout(koffi.pointer(rectangleType)),
    'uint32',
  ]) as (
    fromWindow: unknown,
    toWindow: unknown,
    rectangle: NativeRectangle,
    pointCount: number,
  ) => number;

  return {
    structureSize: koffi.sizeof(guiThreadInfoType),
    getForegroundGuiThreadInfo: (info) => getGuiThreadInfo(0, info),
    mapCaretRectangleToScreen: (hwndCaret, rectangle) => {
      // RECTはPOINT 2個として渡すのがWin32の公式変換方法。
      // 戻り値0は「移動量0」と失敗の両方を表すため、変換後Rectの検証を優先する。
      mapWindowPoints(hwndCaret, null, rectangle, 2);
    },
  };
}

function hasWindowHandle(value: unknown): boolean {
  return value !== null && value !== undefined && value !== 0 && value !== 0n;
}

function toRectangle(value: NativeRectangle): Rectangle | null {
  const coordinates = [value.left, value.top, value.right, value.bottom];
  if (!coordinates.every(Number.isFinite)) {
    return null;
  }

  // Windowsの標準Caretは幅0を返すことがある。
  // Popup anchorとしては1 DIP相当の矩形に正規化し、位置情報を失わない。
  return {
    x: Math.min(value.left, value.right),
    y: Math.min(value.top, value.bottom),
    width: Math.max(1, Math.abs(value.right - value.left)),
    height: Math.max(1, Math.abs(value.bottom - value.top)),
  };
}

export class WindowsCaretLocator {
  readonly #logger = log.scope('caret-locator');
  readonly #nativeApi: WindowsCaretNativeApi | null;

  constructor(nativeApi: WindowsCaretNativeApi | null = createNativeApi()) {
    this.#nativeApi = nativeApi;
  }

  locate(): SelectionAnchor | null {
    const nativeApi = this.#nativeApi;
    if (nativeApi === null) {
      return null;
    }

    const info: GuiThreadInfo = {
      cbSize: nativeApi.structureSize,
      flags: 0,
      hwndActive: null,
      hwndFocus: null,
      hwndCapture: null,
      hwndMenuOwner: null,
      hwndMoveSize: null,
      hwndCaret: null,
      rcCaret: { left: 0, top: 0, right: 0, bottom: 0 },
    };

    try {
      if (!nativeApi.getForegroundGuiThreadInfo(info) || !hasWindowHandle(info.hwndCaret)) {
        return null;
      }

      nativeApi.mapCaretRectangleToScreen(info.hwndCaret, info.rcCaret);
      const rect = toRectangle(info.rcCaret);
      return rect === null ? null : { kind: 'caret', rect };
    } catch (error) {
      // Caretは位置決めの補助であり、取得失敗で翻訳自体を止めない。
      this.#logger.debug('Win32 caret lookup failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return null;
    }
  }
}
