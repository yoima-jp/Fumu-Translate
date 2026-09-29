import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { ScreenCaptureSelection } from '../../shared/contracts';
import { useI18n } from './i18n';
import './screen-capture-overlay.css';

interface Point {
  readonly x: number;
  readonly y: number;
}

type SelectionRect = ScreenCaptureSelection;

const GUIDE = {
  ja: '翻訳したい範囲をドラッグ・Escで取消',
  en: 'Drag to select the area to translate · Esc to cancel',
} as const;

function rectangleFromPoints(start: Point, end: Point): SelectionRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function isJapaneseLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('ja');
}

export function ScreenCaptureOverlay(): React.JSX.Element {
  const { locale } = useI18n();
  const [selection, setSelection] = useState<SelectionRect | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const dragStart = useRef<Point | null>(null);
  const completed = useRef(false);
  const japanese = isJapaneseLocale(locale || navigator.language);

  useLayoutEffect(() => {
    // styles.cssは全windowで共有するため、この一時windowだけ背景を透明にする。
    // Electronの背後にあるdesktopを選択範囲の外側から見せるための設定。
    document.documentElement.classList.add('screen-capture-window');
    document.body.classList.add('screen-capture-window');
    return () => {
      document.documentElement.classList.remove('screen-capture-window');
      document.body.classList.remove('screen-capture-window');
    };
  }, []);

  const complete = useCallback((value: ScreenCaptureSelection | null): void => {
    if (completed.current) return;
    completed.current = true;
    void window.fumu.completeScreenCapture(value).catch((error: unknown) => {
      console.error('Failed to complete screen capture selection', error);
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      complete(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [complete]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || completed.current) return;
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };
    dragStart.current = point;
    setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
    setIsSelecting(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (start === null) return;
    setSelection(rectangleFromPoints(start, { x: event.clientX, y: event.clientY }));
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (start === null) return;
    const rect = rectangleFromPoints(start, { x: event.clientX, y: event.clientY });
    dragStart.current = null;
    setIsSelecting(false);
    complete(rect);
  };

  const handlePointerCancel = (): void => {
    dragStart.current = null;
    setIsSelecting(false);
    complete(null);
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    complete(null);
  };

  return (
    <div
      className="screen-capture-overlay"
      data-selecting={isSelecting}
      onContextMenu={handleContextMenu}
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className="screen-capture-guide" role="status">
        {japanese ? GUIDE.ja : GUIDE.en}
      </div>
      {isSelecting && selection !== null && (
        <div
          aria-hidden="true"
          className="screen-capture-selection"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        />
      )}
    </div>
  );
}
