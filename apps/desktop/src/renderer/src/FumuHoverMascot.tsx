import { useCallback, useEffect, useRef, useState } from 'react';

const CLICK_ANIMATION_DURATION_MS = 620;
const CLICK_PRESS_DEPTH_MS = 100;
const CLICK_TIMER_BUFFER_MS = 20;

export function FumuHoverMascot({ className }: { readonly className?: string }): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const clickTimerRef = useRef<number | undefined>(undefined);
  const clickPauseTimerRef = useRef<number | undefined>(undefined);
  const pressHeldRef = useRef(false);
  const pressStartedAtRef = useRef(0);
  const [clickAnimation, setClickAnimation] = useState({ active: false, paused: false, run: 0 });
  const [hoverSuppressed, setHoverSuppressed] = useState(false);
  const mascotClassName =
    className === undefined
      ? 'fumu-mascot fumu-mascot--hover'
      : `fumu-mascot fumu-mascot--hover ${className}`;

  const startClickAnimation = useCallback((): void => {
    window.clearTimeout(clickTimerRef.current);
    window.clearTimeout(clickPauseTimerRef.current);
    pressHeldRef.current = true;
    pressStartedAtRef.current = performance.now();
    setHoverSuppressed(true);
    setClickAnimation((current) => ({ active: true, paused: false, run: current.run + 1 }));
    clickPauseTimerRef.current = window.setTimeout(() => {
      if (!pressHeldRef.current) return;
      setClickAnimation((current) => ({ ...current, paused: true }));
    }, CLICK_PRESS_DEPTH_MS);
  }, []);

  const releaseClickAnimation = useCallback((): void => {
    if (!pressHeldRef.current) return;
    pressHeldRef.current = false;
    window.clearTimeout(clickPauseTimerRef.current);
    const elapsedBeforeRelease = performance.now() - pressStartedAtRef.current;
    const completedAnimationTime = Math.min(elapsedBeforeRelease, CLICK_PRESS_DEPTH_MS);
    setClickAnimation((current) => ({ ...current, paused: false }));
    clickTimerRef.current = window.setTimeout(
      () => {
        setClickAnimation((current) => ({ ...current, active: false, paused: false }));
      },
      CLICK_ANIMATION_DURATION_MS - completedAnimationTime + CLICK_TIMER_BUFFER_MS,
    );
  }, []);

  useEffect(() => {
    const trigger = svgRef.current?.closest('button');
    if (trigger === null || trigger === undefined) return undefined;

    // SVG自身を二重のボタンにせず、操作主体である親ボタンから入力を受け取る。
    // 押下開始から既存アニメーションを進め、圧縮ピークで一時停止する。
    // 離した後は同じアニメーションの続きへ戻るため、姿勢が巻き戻るガクつきが生じない。
    const handlePointerDown = (event: PointerEvent): void => {
      startClickAnimation();
      trigger.setPointerCapture?.(event.pointerId);
    };
    const handlePointerUp = (event: PointerEvent): void => {
      if (!pressHeldRef.current) return;
      if (trigger.hasPointerCapture?.(event.pointerId)) {
        trigger.releasePointerCapture?.(event.pointerId);
      }
      releaseClickAnimation();
    };
    const handlePointerCancel = (): void => {
      pressHeldRef.current = false;
      window.clearTimeout(clickTimerRef.current);
      window.clearTimeout(clickPauseTimerRef.current);
      setClickAnimation((current) => ({ ...current, active: false, paused: false }));
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) startClickAnimation();
    };
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' || event.key === ' ') releaseClickAnimation();
    };
    const handlePointerLeave = (): void => setHoverSuppressed(false);
    const handleBlur = (): void => setHoverSuppressed(false);
    trigger.addEventListener('pointerdown', handlePointerDown);
    trigger.addEventListener('pointerup', handlePointerUp);
    trigger.addEventListener('pointercancel', handlePointerCancel);
    trigger.addEventListener('pointerleave', handlePointerLeave);
    trigger.addEventListener('keydown', handleKeyDown);
    trigger.addEventListener('keyup', handleKeyUp);
    trigger.addEventListener('blur', handleBlur);

    return () => {
      trigger.removeEventListener('pointerdown', handlePointerDown);
      trigger.removeEventListener('pointerup', handlePointerUp);
      trigger.removeEventListener('pointercancel', handlePointerCancel);
      trigger.removeEventListener('pointerleave', handlePointerLeave);
      trigger.removeEventListener('keydown', handleKeyDown);
      trigger.removeEventListener('keyup', handleKeyUp);
      trigger.removeEventListener('blur', handleBlur);
      window.clearTimeout(clickTimerRef.current);
      window.clearTimeout(clickPauseTimerRef.current);
    };
  }, [releaseClickAnimation, startClickAnimation]);

  // 添付された fumu-hover-click-fixed.svg を安全なReact SVGへ変換している。
  // imgで外部SVGを読むと親ボタンのhover/click状態を内部へ渡せないため、この形を維持する。
  return (
    <svg
      ref={svgRef}
      className={`${mascotClassName}${clickAnimation.active ? ' is-clicking' : ''}${clickAnimation.paused ? ' is-click-paused' : ''}${hoverSuppressed ? ' is-hover-suppressed' : ''}`}
      viewBox="224 209 806 806"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <g key={clickAnimation.run} className="fumu-click-wrap">
        <g className="fumu-hover-wrap">
          <g className="fumu-click-sprout">
            <path
              d="M710 346 C696 327 673 293 649 258 C641 246 645 232 657 225 C669 218 684 223 690 236 C708 276 718 313 719 338 C718 342 715 345 710 346Z"
              fill="#80DF37"
            />
            <path
              d="M716 346 C715 314 719 269 728 232 C731 217 744 208 758 211 C772 214 780 227 777 241 C769 283 751 321 730 346 C725 349 720 349 716 346Z"
              fill="#80DF37"
            />
            <path
              d="M724 347 C747 326 784 302 815 288 C828 282 842 287 848 300 C854 313 848 328 835 334 C798 352 758 357 731 354 C727 353 725 350 724 347Z"
              fill="#80DF37"
            />
          </g>
          <path
            d="M479 341 C397 350 346 382 317 430 C289 477 289 548 289 625 V740 C289 831 294 893 328 938 C364 985 430 1007 523 1011 C575 1014 679 1014 731 1011 C824 1007 890 985 926 938 C960 893 965 831 965 740 V625 C965 548 965 477 937 430 C908 382 857 350 775 341 C687 331 567 331 479 341Z"
            fill="#75DD35"
          />
          <g transform="translate(466 596)">
            <path
              className="fumu-click-eye-white"
              d="M0 31H80V43 C80 70 63 87 40 87 C17 87 0 70 0 43Z"
              fill="#FFFFFF"
            />
            <rect width="80" height="41" rx="11" fill="#0A5338" />
          </g>
          <g transform="translate(701 596)">
            <path
              className="fumu-click-eye-white"
              d="M0 31H80V43 C80 70 63 87 40 87 C17 87 0 70 0 43Z"
              fill="#FFFFFF"
            />
            <rect width="80" height="41" rx="11" fill="#0A5338" />
          </g>
          <g className="fumu-click-mouth">
            <rect x="606" y="696" width="36" height="19" rx="9.5" fill="#0A5338" />
          </g>
        </g>
      </g>
    </svg>
  );
}
