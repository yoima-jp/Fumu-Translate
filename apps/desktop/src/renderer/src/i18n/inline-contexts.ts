import type { UiLocale } from '@fumu/i18n';

const inlineContextCatalog: Readonly<Record<UiLocale, readonly string[]>> = {
  en: [
    'Use “I” as the subject',
    'Use “we” as the subject',
    'Chat with friends',
    'Work chat',
    'Business email',
    'Software development',
    'Customer support',
    'Conversation with a teacher',
    'Contact form',
  ],
  ja: [
    '主語は「私」',
    '主語は「私たち」',
    '友達とのチャットで',
    '職場のチャットで',
    '仕事のメールで',
    'ソフトウェア開発で',
    '顧客対応で',
    '先生との会話で',
    '問い合わせフォームで',
  ],
};

export function defaultInlineContexts(locale: UiLocale): readonly string[] {
  return inlineContextCatalog[locale];
}

export function localizedInlineContext(value: string, locale: UiLocale): string {
  for (const sourceLocale of Object.keys(inlineContextCatalog) as UiLocale[]) {
    const index = inlineContextCatalog[sourceLocale].indexOf(value);
    if (index >= 0) return inlineContextCatalog[locale][index] ?? value;
  }
  return value;
}
