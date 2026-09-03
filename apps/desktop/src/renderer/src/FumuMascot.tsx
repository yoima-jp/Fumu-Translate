import mascotUrl from '../../../build/icon.svg';
import thinkingMascotUrl from './fumu-thinking.svg';
import { FumuHoverMascot } from './FumuHoverMascot';

export function FumuMascot({
  className,
  animated = false,
  hoverable = false,
}: {
  readonly className?: string;
  readonly animated?: boolean;
  readonly hoverable?: boolean;
}): React.JSX.Element {
  // 待機中だけ考え中SVGへ切り替える。通常時のブランドマスコットは静止画のままにして、
  // 応答完了後もアニメーションが残ったり、サイドバーまで動いたりしないようにする。
  if (animated) {
    return (
      <img
        className={className === undefined ? 'fumu-mascot' : `fumu-mascot ${className}`}
        src={thinkingMascotUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }

  if (hoverable) {
    return className === undefined ? (
      <FumuHoverMascot />
    ) : (
      <FumuHoverMascot className={className} />
    );
  }

  return (
    <img
      className={className === undefined ? 'fumu-mascot' : `fumu-mascot ${className}`}
      src={mascotUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
