export type UiLocale = 'en' | 'ja';

export const DEFAULT_UI_LOCALE: UiLocale = 'en';

export interface UiLocaleMetadata {
  readonly locale: UiLocale;
  /** BCP 47 tag for `html lang` and Intl APIs. */
  readonly tag: string;
}

export const UI_LOCALE_METADATA: Readonly<Record<UiLocale, UiLocaleMetadata>> = Object.freeze({
  en: { locale: 'en', tag: 'en' },
  ja: { locale: 'ja', tag: 'ja' },
});

export const UI_LOCALES: readonly UiLocale[] = Object.freeze(['en', 'ja']);

// 母国語設定はUI表示言語とは別概念だが、UIをjaで出し分ける基準は「日本語話者」だけ。
// 上記以外の言語・未設定・不正値はすべて既定のenへ落とす。未知の言語名をjaへ
// 誤マップしないことが重要で、許容リストを明示的に保つことで新言語追加時に
// 翻訳カタログの有無と整合を取らせられる。
const JAPANESE_NATIVE_LANGUAGE = 'Japanese';

/**
 * Resolve the UI locale from an arbitrary native-language value.
 *
 * Returns 'ja' only for the Japanese native language; every other language,
 * null, undefined, and unknown values fall back to the default English UI.
 */
export function resolveUiLocale(nativeLanguage: unknown): UiLocale {
  // 厳密一致のみ。曖昧一致（小文字、BCP 47コード、現地表記）は誤検知を生むため
  // スコープ外とし、すべてenへfallbackする。
  if (nativeLanguage === JAPANESE_NATIVE_LANGUAGE) {
    return 'ja';
  }
  return DEFAULT_UI_LOCALE;
}

export function resolveEnvironmentUiLocale(languageTags: readonly string[]): UiLocale {
  const primaryLanguage = languageTags[0]?.trim().toLocaleLowerCase();
  return primaryLanguage === 'ja' || primaryLanguage?.startsWith('ja-') === true ? 'ja' : 'en';
}
