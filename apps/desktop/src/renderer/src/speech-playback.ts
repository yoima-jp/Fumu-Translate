import { NATIVE_LANGUAGE_OPTIONS } from '../../shared/settings-contracts';

export function speechLanguageTag(language: string | undefined): string {
  if (language === undefined) return '';
  const normalized = language.trim().toLocaleLowerCase();
  return (
    NATIVE_LANGUAGE_OPTIONS.find(
      (option) =>
        option.value.toLocaleLowerCase() === normalized ||
        option.label.toLocaleLowerCase() === normalized ||
        option.tag.toLocaleLowerCase() === normalized,
    )?.tag ?? ''
  );
}

function normalizedLanguageTag(tag: string): string {
  return tag.trim().replaceAll('_', '-').toLocaleLowerCase();
}

export function speechVoiceForLanguage<T extends { readonly lang: string }>(
  voices: readonly T[],
  requestedTag: string,
): T | null {
  const normalizedRequested = normalizedLanguageTag(requestedTag);
  if (!normalizedRequested) return null;

  const exact = voices.find((voice) => normalizedLanguageTag(voice.lang) === normalizedRequested);
  if (exact !== undefined) return exact;

  const compatibleTags =
    normalizedRequested === 'zh-hans'
      ? ['zh-cn', 'zh-sg', 'zh']
      : normalizedRequested === 'zh-hant'
        ? ['zh-tw', 'zh-hk', 'zh-mo', 'zh']
        : normalizedRequested.includes('-')
          ? [normalizedRequested.split('-')[0]]
          : [];
  const compatible = voices.find((voice) =>
    compatibleTags.includes(normalizedLanguageTag(voice.lang)),
  );
  if (compatible !== undefined) return compatible;

  // 言語だけが指定された場合は、Windows側の地域バリエーションをどれでも利用できる。
  if (!normalizedRequested.includes('-')) {
    return (
      voices.find((voice) =>
        normalizedLanguageTag(voice.lang).startsWith(`${normalizedRequested}-`),
      ) ?? null
    );
  }
  return null;
}
