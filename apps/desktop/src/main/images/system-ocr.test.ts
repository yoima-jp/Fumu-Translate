import { describe, expect, it } from 'vitest';
import { chooseOcrCandidate, joinOcrLines } from './system-ocr';

describe('joinOcrLines', () => {
  it('joins CJK characters without spaces and keeps spaces between Latin words', () => {
    expect(
      joinOcrLines([
        ['モ', 'ッ', 'ク', '画', '像', 'で', 'す', '。'],
        ['Translated', 'naturally:', 'モ', 'ッ', 'ク'],
        [],
        ['Hello', 'World'],
      ]),
    ).toBe('モック画像です。\nTranslated naturally:モック\nHello World');
  });
});

describe('chooseOcrCandidate', () => {
  it('uses the Latin recognizer when the CJK recognizer read mostly Latin text', () => {
    expect(
      chooseOcrCandidate([
        { language: 'ja', text: 'Theundisputed leaderisthe Main page' },
        { language: 'en-US', text: 'The undisputed leader is the Main page' },
      ])?.language,
    ).toBe('en-US');
  });

  it('keeps the CJK recognizer for Japanese text', () => {
    expect(
      chooseOcrCandidate([
        { language: 'ja', text: 'モック画像からの書き起こし Mock' },
        { language: 'en-US', text: 'Mock' },
      ])?.language,
    ).toBe('ja');
  });
});

describe('chooseOcrCandidate with mixed text', () => {
  it('keeps Japanese runs even when most letters are Latin', () => {
    expect(
      chooseOcrCandidate([
        { language: 'ja', text: 'Hello World画像翻訳' },
        { language: 'en-US', text: 'Hello World' },
      ])?.language,
    ).toBe('ja');
  });
});
