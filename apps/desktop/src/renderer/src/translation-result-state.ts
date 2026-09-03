import type { TranslationResult, TranslationSnapshot } from '@fumu/translation-core';
import type { TranslationViewState } from '../../shared/contracts';

export interface StoredBackTranslationResult {
  readonly value: TranslationSnapshot;
  readonly assessmentVisible: boolean;
}

export function rememberCompletedBackTranslation(
  current: ReadonlyMap<string, StoredBackTranslationResult>,
  state: TranslationViewState,
): ReadonlyMap<string, StoredBackTranslationResult> {
  if (
    state.operation !== 'back-translate' ||
    state.phase !== 'completed' ||
    state.previousValue === null
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(state.previousValue.translation, {
    value: state.value,
    assessmentVisible: backTranslationAssessmentVisible(state),
  });
  return next;
}

export function displayedTranslationValue(state: TranslationViewState): TranslationSnapshot | null {
  if (state.phase === 'completed' || state.phase === 'streaming') return state.value;
  if (state.phase === 'failed') return state.lastSnapshot ?? state.previousValue;
  return state.previousValue;
}

export function previousTranslationValue(state: TranslationViewState): TranslationResult | null {
  return state.previousValue;
}

export function operationTranslationValue(state: TranslationViewState): TranslationSnapshot | null {
  if (state.phase === 'streaming' || state.phase === 'completed') return state.value;
  if (state.phase === 'failed') return state.lastSnapshot;
  return null;
}

export function backTranslationAssessmentVisible(state: TranslationViewState): boolean {
  // 戻し訳本文は生成中から読めるようにする一方、自然さ・意味保持・評価理由は
  // 独立評価が両方とも完了するまで見せない。評価APIが失敗した場合も、未確定値を
  // 「判定不能」という完了済みの判定に見せないため、判定欄そのものを表示しない。
  return (
    state.operation === 'back-translate' &&
    state.phase === 'completed' &&
    typeof state.value.isNatural === 'boolean' &&
    typeof state.value.meaningPreserved === 'boolean'
  );
}

interface VerdictLabels {
  readonly positive: string;
  readonly negative: string;
  readonly unknown: string;
}

export function backTranslationVerdict(
  value: boolean | undefined,
  labels: VerdictLabels,
): {
  readonly tone: 'positive' | 'negative' | 'unknown';
  readonly label: string;
} {
  if (value === true) return { tone: 'positive', label: labels.positive };
  if (value === false) return { tone: 'negative', label: labels.negative };
  return { tone: 'unknown', label: labels.unknown };
}
