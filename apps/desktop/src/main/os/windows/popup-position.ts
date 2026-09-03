import type { Point, Rectangle, SelectionAnchor } from '../../../shared/contracts';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface PopupPositionOptions {
  readonly gap: number;
  readonly margin: number;
}

const DEFAULT_OPTIONS: PopupPositionOptions = {
  gap: 8,
  margin: 8,
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) {
    return minimum;
  }

  return Math.min(Math.max(value, minimum), maximum);
}

function anchorRectangle(anchor: SelectionAnchor): Rectangle {
  if (anchor.kind === 'selection' || anchor.kind === 'caret') {
    return anchor.rect;
  }

  return {
    x: anchor.point.x,
    y: anchor.point.y,
    width: 0,
    height: 0,
  };
}

/**
 * Popupの初期位置は選択終端の右下を優先する。
 * 画面端では反対側へ置いてからClampすることで、単純なClampより原文を覆いにくくする。
 */
export function calculatePopupBounds(
  anchor: SelectionAnchor,
  popupSize: Size,
  workArea: Rectangle,
  options: PopupPositionOptions = DEFAULT_OPTIONS,
): Rectangle {
  const source = anchorRectangle(anchor);
  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;

  let x = source.x + source.width + options.gap;
  let y = source.y + source.height + options.gap;

  if (x + popupSize.width + options.margin > workRight) {
    x = source.x - popupSize.width - options.gap;
  }

  if (y + popupSize.height + options.margin > workBottom) {
    y = source.y - popupSize.height - options.gap;
  }

  return {
    x: Math.round(
      clamp(x, workArea.x + options.margin, workRight - popupSize.width - options.margin),
    ),
    y: Math.round(
      clamp(y, workArea.y + options.margin, workBottom - popupSize.height - options.margin),
    ),
    width: Math.round(Math.min(popupSize.width, workArea.width - options.margin * 2)),
    height: Math.round(Math.min(popupSize.height, workArea.height - options.margin * 2)),
  };
}

export function workAreaCenter(workArea: Rectangle): Point {
  return {
    x: workArea.x + workArea.width / 2,
    y: workArea.y + workArea.height / 2,
  };
}
