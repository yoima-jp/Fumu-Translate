import './onboarding-mascot.css';

// departure: welcome開始時にその場で沈み込み→真上へ射出され、画面外へ抜けるフェーズ。
// landing: complete画面到着時に上の画面外から落下し、着地の潰れと反動で止まるフェーズ。
// 両フェーズの移動は親フレーム(styles.css)が担い、このコンポーネント内では
// 潰し・伸び・若芽・目の表情だけを obm- 内部グループで再生する。
export type OnboardingMascotPhase =
  'entering' | 'idle' | 'departure' | 'landing' | 'complete' | 'handoff';

// 幾何・塗り・viewBox は apps/desktop/build/icon.svg（実使用中は FumuHoverMascot.tsx と同一形状）からの
// 一語一句の転写であり、このリポジトリの SVG だけがキャラクターの正である。参考画像や新規デザインは持ち込まない。
// icon.svg の defs グラデーションはどの形状からも参照されておらず、現行コンポーネントも単色塗りのため、
// 単色のままで描画結果が完全に一致する。将来 gradient を使う場合は FumuHoverMascot 側と同時に揃えること。
export function OnboardingMascot({
  className,
  phase,
}: {
  readonly className?: string;
  readonly phase: OnboardingMascotPhase;
}): React.JSX.Element {
  const mascotClassName =
    className === undefined
      ? `obm-mascot obm-mascot--${phase}`
      : `obm-mascot obm-mascot--${phase} ${className}`;

  // 目の <g> は transform="translate(...)" 属性で配置されており、ここへ CSS transform を掛けると
  // 属性が上書きされて目が原点へ飛ぶ。FumuHoverMascot と同じく、動かすのは白目の path のみとする。
  //
  // アニメーションはすべて内部の <g> で再生し、svg ルートには transform を残さない。
  // handoff 以降は親がルートを移動・拡大するため、transform の所有権を親へ完全に譲る必要がある。
  return (
    <svg
      className={mascotClassName}
      viewBox="224 209 806 806"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <g className="obm-stage">
        <g className="obm-sprout">
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
            className="obm-eye-white"
            d="M0 31H80V43 C80 70 63 87 40 87 C17 87 0 70 0 43Z"
            fill="#FFFFFF"
          />
          <rect width="80" height="41" rx="11" fill="#0A5338" />
        </g>
        <g transform="translate(701 596)">
          <path
            className="obm-eye-white"
            d="M0 31H80V43 C80 70 63 87 40 87 C17 87 0 70 0 43Z"
            fill="#FFFFFF"
          />
          <rect width="80" height="41" rx="11" fill="#0A5338" />
        </g>
        <g className="obm-mouth">
          <rect x="606" y="696" width="36" height="19" rx="9.5" fill="#0A5338" />
        </g>
      </g>
    </svg>
  );
}
