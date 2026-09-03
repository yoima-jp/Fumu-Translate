/// <reference types="vite/client" />

import { DEFAULT_UI_LOCALE, UI_LOCALE_METADATA, type UiLocale } from '@fumu/i18n';
import doneIconSvg from './done-icon.svg?raw';

const DONE_ICON = doneIconSvg.replace(
  '<svg ',
  '<svg class="done-icon" aria-hidden="true" focusable="false" ',
);

type OAuthPageKind = 'success' | 'error';

interface OAuthPageCopy {
  readonly title: string;
  readonly detail: string;
}

// ブラウザタブ直開きのcallback page向けカタログ。provider内部診断メッセージ
// （token endpointエラー等）は対象外。
const CATALOG: Readonly<Record<UiLocale, Readonly<Record<OAuthPageKind, OAuthPageCopy>>>> =
  Object.freeze({
    en: Object.freeze({
      success: Object.freeze({
        title: 'Login complete',
        detail: 'You can close this page and return to the Fumu desktop app.',
      }),
      error: Object.freeze({
        title: 'Could not log in',
        detail: 'You can close this page and try again from Fumu.',
      }),
    }),
    ja: Object.freeze({
      success: Object.freeze({
        title: 'ログインが完了しました',
        detail: 'このページを閉じて、デスクトップアプリに戻ってください。',
      }),
      error: Object.freeze({
        title: 'ログインできませんでした',
        detail: 'このページを閉じて、Fumuからもう一度お試しください。',
      }),
    }),
  });

// 404応答の平文テキスト。HTMLページと同一カタログで管理する。
const NOT_FOUND_TEXT: Readonly<Record<UiLocale, string>> = Object.freeze({
  en: 'Not found',
  ja: '見つかりません',
});

export function oauthPageNotFoundText(locale: UiLocale = DEFAULT_UI_LOCALE): string {
  return NOT_FOUND_TEXT[locale];
}

function fumuMark(className: string): string {
  return `<svg class="${className}" viewBox="224 209 806 806" aria-hidden="true">
    <path d="M710 346C696 327 673 293 649 258C641 246 645 232 657 225C669 218 684 223 690 236C708 276 718 313 719 338C718 342 715 345 710 346Z" fill="#80df37"/>
    <path d="M716 346C715 314 719 269 728 232C731 217 744 208 758 211C772 214 780 227 777 241C769 283 751 321 730 346C725 349 720 349 716 346Z" fill="#80df37"/>
    <path d="M724 347C747 326 784 302 815 288C828 282 842 287 848 300C854 313 848 328 835 334C798 352 758 357 731 354C727 353 725 350 724 347Z" fill="#80df37"/>
    <path d="M479 341C397 350 346 382 317 430C289 477 289 548 289 625V740C289 831 294 893 328 938C364 985 430 1007 523 1011C575 1014 679 1014 731 1011C824 1007 890 985 926 938C960 893 965 831 965 740V625C965 548 965 477 937 430C908 382 857 350 775 341C687 331 567 331 479 341Z" fill="#75dd35"/>
    <path d="M466 627H546V639C546 666 529 683 506 683C483 683 466 666 466 639Z" fill="#fff"/>
    <rect x="466" y="596" width="80" height="41" rx="11" fill="#0a5338"/>
    <path d="M701 627H781V639C781 666 764 683 741 683C718 683 701 666 701 639Z" fill="#fff"/>
    <rect x="701" y="596" width="80" height="41" rx="11" fill="#0a5338"/>
    <rect x="606" y="696" width="36" height="19" rx="9.5" fill="#0a5338"/>
  </svg>`;
}

export function renderOAuthPage(kind: OAuthPageKind, locale: UiLocale = DEFAULT_UI_LOCALE): string {
  const copy = CATALOG[locale][kind];
  return `<!doctype html>
<html lang="${UI_LOCALE_METADATA[locale].tag}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${copy.title} — Fumu</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, "Noto Sans JP", "Yu Gothic UI", sans-serif;
      --page-ink: #142019;
      --page-muted: #748078;
      --page-canvas: #f2f8ec;
      --page-brand: #101714;
      --page-shadow: rgb(33 91 44 / 12%);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --page-ink: #f3f5f4;
        --page-muted: #a3aaa7;
        --page-canvas: #0d1010;
        --page-brand: #f3f5f4;
        --page-shadow: rgb(0 0 0 / 34%);
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; min-height: 100vh; color: var(--page-ink); background: var(--page-canvas); }
    header { position: fixed; inset: 0 0 auto; display: flex; align-items: center; padding: 18px 20px; }
    .brand { display: flex; align-items: center; gap: 10px; color: var(--page-brand); font-size: 24px; font-style: italic; font-weight: 800; letter-spacing: -.05em; }
    .brand-mark { width: 38px; height: 38px; filter: drop-shadow(0 3px 6px var(--page-shadow)); }
    main { min-height: 100vh; display: grid; place-items: center; padding: 96px 24px; }
    .status { width: min(100%, 520px); text-align: center; transform: translateY(-2vh); }
    .status > svg { display: block; width: 128px; height: 128px; margin: 0 auto 10px; overflow: visible; }
    h1 { margin: 0; font-size: clamp(20px, 2vw, 24px); font-weight: 760; line-height: 1.45; letter-spacing: -.025em; }
    p { max-width: 460px; margin: 18px auto 0; color: var(--page-muted); font-size: 16px; line-height: 1.75; }
    @media (max-width: 560px) {
      header { padding: 16px; }
      .brand { font-size: 21px; }
      .brand-mark { width: 34px; height: 34px; }
      main { padding-inline: 28px; }
      .status { transform: translateY(-1vh); }
      .status > svg { width: 116px; height: 116px; }
      p { font-size: 15px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">${fumuMark('brand-mark')}<span>Fumu!</span></div>
  </header>
  <main>
    <section class="status" aria-live="polite">
      ${DONE_ICON}
      <h1>${copy.title}</h1>
      <p>${copy.detail}</p>
    </section>
  </main>
</body>
</html>`;
}
