import { describe, expect, it } from 'vitest';
import { buildTranslationMessages } from './prompt';
import type { TranslationRequest } from './contracts';

function payload(request: Partial<TranslationRequest> = {}) {
  const messages = buildTranslationMessages({
    requestId: 'test',
    sourceText: 'That works for me.',
    languageRouting: { nativeLanguage: 'Japanese', otherLanguageTarget: 'English' },
    ...request,
  });
  return JSON.parse(messages.find((message) => message.role === 'user')!.content as string);
}

describe('translation language routing', () => {
  it.each(['That works for me.', 'それで大丈夫です。', 'Bonjour !'])(
    'sends only automatic routing for %s',
    (sourceText) => {
      const request = payload({ sourceText });
      expect(request).not.toHaveProperty('targetLanguage');
      expect(request.languageRouting.rules).toEqual([
        'If the detected source language is Japanese, translate to English.',
        'For every other source language, translate to Japanese.',
      ]);
    },
  );
  it('keeps the configured non-native target', () => {
    expect(
      payload({ languageRouting: { nativeLanguage: 'Japanese', otherLanguageTarget: 'French' } })
        .languageRouting.rules[0],
    ).toContain('translate to French');
  });
  it('gives explicit targets precedence over automatic routing', () => {
    const request = payload({ targetLanguage: 'German' });
    expect(request.targetLanguage).toBe('German');
    expect(request).not.toHaveProperty('languageRouting');
  });
  it.each(['polite', 'back-translate'] as const)(
    'keeps the result language for %s',
    (operation) => {
      const request = payload({
        operation,
        currentResult: {
          translation: 'それで大丈夫です。',
          explanation: '',
          alternatives: [],
          sourceLanguage: 'English',
          targetLanguage: 'Japanese',
        },
      });
      expect(request.targetLanguage).toBe(operation === 'back-translate' ? 'English' : 'Japanese');
      expect(request).not.toHaveProperty('languageRouting');
    },
  );
});
