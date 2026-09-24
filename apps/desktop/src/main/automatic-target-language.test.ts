import { describe, expect, it } from 'vitest';
import { automaticTargetLanguage } from './automatic-target-language';

// 既定の構成（母国語=日本語、対訳先=英語）で、ショートカット翻訳の翻訳先がどう決まるかを固定する。
const JAPANESE_NATIVE = { nativeLanguage: 'Japanese', otherLanguageTarget: 'English' } as const;

describe('automaticTargetLanguage', () => {
  it('sends kana text to the configured counterpart', () => {
    expect(automaticTargetLanguage('これは日本語の文章です。', JAPANESE_NATIVE)).toBe('English');
  });

  it('uses the configured counterpart instead of a fixed English target', () => {
    expect(
      automaticTargetLanguage('これは日本語の文章です。', {
        nativeLanguage: 'Japanese',
        otherLanguageTarget: 'French',
      }),
    ).toBe('French');
  });

  it('sends text without Han characters to the native language', () => {
    expect(automaticTargetLanguage('Universal Config is a client-side mod.', JAPANESE_NATIVE)).toBe(
      'Japanese',
    );
  });

  it('sends Simplified Chinese text to the native language', () => {
    expect(automaticTargetLanguage('您好，我在日本，想购买并下载这个软件。', JAPANESE_NATIVE)).toBe(
      'Japanese',
    );
  });

  it('sends short Chinese text containing a Chinese-only character to the native language', () => {
    expect(automaticTargetLanguage('查看内容', JAPANESE_NATIVE)).toBe('Japanese');
  });

  it('sends Traditional Chinese text to the native language', () => {
    expect(automaticTargetLanguage('這個內容需要購買', JAPANESE_NATIVE)).toBe('Japanese');
  });

  // かなを含まない日本語の漢字語。中国語と誤ると原文がそのまま返る無意味な翻訳になるため、
  // 中国語の証拠が無い限り確定しない。
  it.each([
    '互換性',
    '画面例',
    '期間限定',
    '注意事項',
    '東京都新宿区西新宿',
    '株式会社零霧構想',
    '無料',
  ])('keeps provider routing for Han-only Japanese text (%s)', (sourceText) => {
    expect(automaticTargetLanguage(sourceText, JAPANESE_NATIVE)).toBeNull();
  });

  it('does not decide anything when the native language is unknown or not Japanese', () => {
    expect(
      automaticTargetLanguage('您好，我在日本，想购买并下载这个软件。', {
        nativeLanguage: 'English',
        otherLanguageTarget: 'Japanese',
      }),
    ).toBeNull();
    expect(
      automaticTargetLanguage('これは日本語の文章です。', {
        nativeLanguage: null,
        otherLanguageTarget: 'English',
      }),
    ).toBeNull();
  });
});
