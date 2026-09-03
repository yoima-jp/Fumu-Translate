import type {
  TranslationEvent,
  TranslationOperation,
  TranslationResult,
} from '@fumu/translation-core';
import type { TranslationViewState } from '../shared/contracts';

export function initialTranslationViewState(): TranslationViewState {
  return {
    phase: 'loading',
    operation: 'translate',
    previousValue: null,
    cards: [],
  };
}

export function beginTranslationViewOperation(
  state: TranslationViewState,
  operation: TranslationOperation,
  previousValue: TranslationResult | null,
  writingStyleName?: string,
): TranslationViewState {
  const writingStyle = writingStyleName === undefined ? {} : { writingStyleName };
  return {
    phase: 'loading',
    operation,
    previousValue,
    cards: state.cards,
    ...writingStyle,
  };
}

export function applyTranslationViewEvent(
  state: TranslationViewState,
  event: TranslationEvent,
): TranslationViewState {
  const { operation, previousValue, cards, writingStyleName } = state;
  const writingStyle = writingStyleName === undefined ? {} : { writingStyleName };
  switch (event.type) {
    case 'started':
      return { phase: 'loading', operation, previousValue, cards, ...writingStyle };
    case 'snapshot':
      return {
        phase: 'streaming',
        operation,
        previousValue,
        cards,
        sequence: event.sequence,
        value: event.value,
        ...writingStyle,
      };
    case 'completed':
      return {
        phase: 'completed',
        operation,
        value: event.value,
        previousValue,
        // 戻し訳は新しい翻訳カードではなく、操作対象だった最後のカード内に表示する。
        // それ以外の調整結果だけをカード列へ追加し、前段のカードを失わない。
        cards:
          operation === 'back-translate'
            ? cards
            : [...cards, { operation, value: event.value, ...writingStyle }],
        ...writingStyle,
      };
    case 'failed':
      return {
        phase: 'failed',
        code: event.code,
        message: event.message,
        retryable: event.retryable,
        lastSnapshot: state.phase === 'streaming' ? state.value : null,
        ...(event.debugResponse === undefined ? {} : { debugResponse: event.debugResponse }),
        operation,
        previousValue,
        cards,
        ...writingStyle,
      };
    case 'cancelled':
      return state;
  }
}
