import {
  MAX_INLINE_TRANSLATION_CONTEXT_CODE_POINTS,
  normalizeInlineTranslationContext,
  validateInlineTranslationContexts,
} from '@fumu/translation-core';

export function normalizeInlineContext(value: string): string {
  return Array.from(normalizeInlineTranslationContext(value))
    .slice(0, MAX_INLINE_TRANSLATION_CONTEXT_CODE_POINTS)
    .join('');
}

export function inlineContextCandidates(
  query: string,
  currentContexts: readonly string[],
  defaultContexts: readonly string[],
): readonly { readonly value: string; readonly custom: boolean }[] {
  const normalizedQuery = normalizeInlineContext(query);
  const queryForMatch = normalizedQuery.toLocaleLowerCase();
  const canAdd = (value: string): boolean => {
    if (currentContexts.includes(value)) return false;
    return validateInlineTranslationContexts([...currentContexts, value]).success;
  };
  const defaults = defaultContexts
    .filter((context) => context.toLocaleLowerCase().includes(queryForMatch) && canAdd(context))
    .map((value) => ({ value, custom: false }));
  const hasExactDefault = defaultContexts.some(
    (context) => context.toLocaleLowerCase() === queryForMatch,
  );
  return normalizedQuery.length === 0 || hasExactDefault || !canAdd(normalizedQuery)
    ? defaults
    : [{ value: normalizedQuery, custom: true }, ...defaults];
}

export function isInlineContextTriggerBoundary(text: string, markerOffset: number): boolean {
  if (markerOffset === 0) return true;
  const previous = Array.from(text.slice(0, markerOffset)).at(-1);
  return previous !== undefined && /[\s\u200b]/u.test(previous);
}
