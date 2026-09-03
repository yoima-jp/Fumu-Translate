import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import gazeUrl from './assets/idle-animations/anim-gaze.svg';
import dozeUrl from './assets/idle-animations/anim-doze.svg';
import jumpUrl from './assets/idle-animations/anim-jump.svg';
import sproutUrl from './assets/idle-animations/anim-sprout.svg';
import blinkUrl from './assets/idle-animations/anim-blink.svg';
import { FumuMascot } from './FumuMascot';

export type IdleAnimationName = 'gaze' | 'doze' | 'jump' | 'sprout' | 'blink';

export const IDLE_ANIMATION_DURATIONS_MS: Readonly<Record<IdleAnimationName, number>> = {
  gaze: 5_200,
  doze: 6_000,
  jump: 3_700,
  sprout: 2_400,
  blink: 4_200,
};

export const IDLE_WAIT_MIN_MS = 20_000;
export const IDLE_WAIT_MAX_MS = 45_000;
export const DOZE_MIN_IDLE_MS = 90_000;

const ANIMATION_SOURCES: Readonly<Record<IdleAnimationName, string>> = {
  gaze: gazeUrl,
  doze: dozeUrl,
  jump: jumpUrl,
  sprout: sproutUrl,
  blink: blinkUrl,
};

const ACTIVITY_EVENTS = [
  'pointerdown',
  'keydown',
  'wheel',
  'touchstart',
  'input',
  'focusin',
] as const;

type WeightedAnimation = { readonly name: IdleAnimationName; readonly weight: number };
type MascotBounds = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

// 通常イベントを中心にしつつ、jump/dozeは「たまに出会える」割合に抑える。
// dozeは下の選択関数で無操作時間の条件も満たした場合だけ候補へ入る。
const COMMON_ANIMATIONS: readonly WeightedAnimation[] = [
  { name: 'gaze', weight: 30 },
  { name: 'blink', weight: 38 },
  { name: 'sprout', weight: 25 },
  { name: 'jump', weight: 7 },
];
const DOZE_ANIMATION: WeightedAnimation = { name: 'doze', weight: 3 };

export function selectIdleAnimation(
  idleDurationMs: number,
  randomValue = Math.random(),
): IdleAnimationName {
  const animations =
    idleDurationMs >= DOZE_MIN_IDLE_MS ? [...COMMON_ANIMATIONS, DOZE_ANIMATION] : COMMON_ANIMATIONS;
  const totalWeight = animations.reduce((sum, animation) => sum + animation.weight, 0);
  const boundedRandom = Math.min(0.999999, Math.max(0, randomValue));
  let threshold = boundedRandom * totalWeight;

  for (const animation of animations) {
    threshold -= animation.weight;
    if (threshold < 0) return animation.name;
  }

  return animations.at(-1)?.name ?? 'blink';
}

export function randomIdleWait(randomValue = Math.random()): number {
  const boundedRandom = Math.min(0.999999, Math.max(0, randomValue));
  return IDLE_WAIT_MIN_MS + Math.floor(boundedRandom * (IDLE_WAIT_MAX_MS - IDLE_WAIT_MIN_MS + 1));
}

export function IdleMascot({
  disabled = false,
}: {
  readonly disabled?: boolean;
}): React.JSX.Element {
  const layerRef = useRef<HTMLSpanElement>(null);
  const [activeAnimation, setActiveAnimation] = useState<IdleAnimationName | null>(null);
  const [animationRun, setAnimationRun] = useState(0);
  const [jumpOrigin, setJumpOrigin] = useState<MascotBounds | null>(null);

  useEffect(() => {
    // 初回再生時の画像取得による透明な1フレームを避けるため、待機中でなくても先に読み込む。
    Object.values(ANIMATION_SOURCES).forEach((source) => {
      const image = new Image();
      image.src = source;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let idleStartedAt = performance.now();
    let scheduleTimer: number | undefined;
    let finishTimer: number | undefined;
    const listenerOptions: AddEventListenerOptions = { capture: true };

    const clearTimers = (): void => {
      window.clearTimeout(scheduleTimer);
      window.clearTimeout(finishTimer);
      scheduleTimer = undefined;
      finishTimer = undefined;
    };

    const scheduleNext = (): void => {
      if (disposed || document.visibilityState !== 'visible') return;
      window.clearTimeout(scheduleTimer);
      scheduleTimer = window.setTimeout(startAnimation, randomIdleWait());
    };

    const startAnimation = (): void => {
      if (disposed || document.visibilityState !== 'visible') return;
      scheduleTimer = undefined;
      const name = selectIdleAnimation(performance.now() - idleStartedAt);
      if (name === 'jump') {
        const bounds = layerRef.current?.getBoundingClientRect();
        setJumpOrigin(
          bounds === undefined
            ? null
            : {
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
              },
        );
      } else {
        setJumpOrigin(null);
      }
      setActiveAnimation(name);
      setAnimationRun((run) => run + 1);
      finishTimer = window.setTimeout(() => {
        if (disposed) return;
        finishTimer = undefined;
        setActiveAnimation(null);
        setJumpOrigin(null);
        scheduleNext();
      }, IDLE_ANIMATION_DURATIONS_MS[name]);
    };

    const resetSchedule = (): void => {
      idleStartedAt = performance.now();
      clearTimers();
      setActiveAnimation(null);
      setJumpOrigin(null);
      scheduleNext();
    };

    const handleActivity = (): void => resetSchedule();
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        resetSchedule();
      } else {
        clearTimers();
        setActiveAnimation(null);
        setJumpOrigin(null);
      }
    };

    if (disabled) {
      clearTimers();
      setActiveAnimation(null);
      return () => undefined;
    }

    ACTIVITY_EVENTS.forEach((eventName) =>
      document.addEventListener(eventName, handleActivity, listenerOptions),
    );
    document.addEventListener('visibilitychange', handleVisibilityChange);
    scheduleNext();

    return () => {
      disposed = true;
      clearTimers();
      ACTIVITY_EVENTS.forEach((eventName) =>
        document.removeEventListener(eventName, handleActivity, listenerOptions),
      );
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [disabled]);

  const jumpIsPortaled = activeAnimation === 'jump' && jumpOrigin !== null;

  return (
    <>
      <span
        ref={layerRef}
        className={`fumu-idle-mascot-layer${activeAnimation === null ? '' : ' is-active'}${jumpIsPortaled ? ' is-jumping' : ''}`}
      >
        <FumuMascot hoverable />
        {activeAnimation !== null && !jumpIsPortaled && (
          <img
            key={animationRun}
            className="fumu-mascot fumu-idle-mascot"
            src={ANIMATION_SOURCES[activeAnimation]}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        )}
      </span>
      {jumpIsPortaled &&
        createPortal(
          <img
            key={animationRun}
            className="fumu-mascot fumu-idle-jump"
            src={ANIMATION_SOURCES.jump}
            style={jumpOrigin}
            alt=""
            aria-hidden="true"
            draggable={false}
          />,
          document.body,
        )}
    </>
  );
}
