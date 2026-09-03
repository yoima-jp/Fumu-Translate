import {
  MAX_CONVERSATION_CONTEXT_TEXT_CODE_POINTS,
  MAX_CONVERSATION_CONTEXT_TURNS,
  type ConversationContextTurn,
  type TranslationResult,
} from '@fumu/translation-core';
import type { TranslationViewState } from '../../../shared/contracts';
import type { HistoryResultView } from '../../../shared/history-contracts';
import type { AppliedTranslationInstruction } from './applied-translation-instructions';

export type ConversationDirection = 'incoming' | 'outgoing';

export interface ConversationTurn {
  readonly id: string;
  readonly direction: ConversationDirection;
  readonly sourceText: string;
  readonly translation: TranslationViewState;
  readonly appliedInstructions: readonly AppliedTranslationInstruction[];
}

export interface ConversationHistoryTurn {
  readonly direction: ConversationDirection;
  readonly sourceText: string;
  readonly results: readonly HistoryResultView[];
}

export function completedConversationResult(
  translation: TranslationViewState,
): TranslationResult | null {
  if (translation.phase !== 'completed') return null;
  // 調整後は最後のカードが実際に送る訳文になる。戻し訳の結果そのものは送信文にせず、
  // 検証対象だった最後の翻訳カードを会話文脈へ引き継ぐ。
  return (
    translation.cards.at(-1)?.value ??
    (translation.operation === 'back-translate' ? translation.previousValue : translation.value)
  );
}

export function shouldSubmitConversationReply(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  enterToSend: boolean,
): boolean {
  if (event.key !== 'Enter') return false;
  // 本文エディターと同じ規則: Ctrl/Cmd+Enterは常に送信し、設定ON時だけEnter単体も送信。
  return event.ctrlKey || event.metaKey || (enterToSend && !event.shiftKey);
}

export function conversationTurnsFromHistory(
  results: readonly HistoryResultView[],
): readonly ConversationHistoryTurn[] {
  const turns: ConversationHistoryTurn[] = [];
  for (const result of results) {
    if (result.conversationDirection === undefined) continue;
    const current = turns.at(-1);
    // translateは必ず新しい発話の開始。後続の調整・戻し訳は同じ発話へ束ねる。
    if (result.operation === 'translate' || current === undefined) {
      turns.push({
        direction: result.conversationDirection,
        sourceText: result.sourceText,
        results: [result],
      });
      continue;
    }
    turns[turns.length - 1] = { ...current, results: [...current.results, result] };
  }
  return turns;
}

export function translationStateFromHistory(
  results: readonly HistoryResultView[],
): TranslationViewState | null {
  const latestTranslation = results.findLast((result) => result.operation !== 'back-translate');
  const latestOperation = results.at(-1);
  if (latestTranslation === undefined || latestOperation === undefined) return null;
  return {
    phase: 'completed',
    operation: latestOperation.operation,
    ...(latestOperation.writingStyleName === undefined
      ? {}
      : { writingStyleName: latestOperation.writingStyleName }),
    value: latestOperation.value,
    previousValue: latestOperation.operation === 'back-translate' ? latestTranslation.value : null,
    cards: results.flatMap((result) =>
      result.operation === 'back-translate'
        ? []
        : [
            {
              operation: result.operation,
              ...(result.writingStyleName === undefined
                ? {}
                : { writingStyleName: result.writingStyleName }),
              value: result.value,
            },
          ],
    ),
  };
}

export function conversationTranslationTurnsFromHistory(
  results: readonly HistoryResultView[],
): readonly ConversationTurn[] {
  return conversationTurnsFromHistory(results).flatMap((turn, index) => {
    const translation = translationStateFromHistory(turn.results);
    if (translation === null) return [];
    const initialTranslation = turn.results.find((result) => result.operation === 'translate');
    return [
      {
        id: turn.results[0]?.id ?? String(index),
        direction: turn.direction,
        sourceText: turn.sourceText,
        translation,
        appliedInstructions: initialTranslation?.appliedInstructions ?? [],
      },
    ];
  });
}

export function nextConversationDirection(direction: ConversationDirection): ConversationDirection {
  return direction === 'incoming' ? 'outgoing' : 'incoming';
}

function truncateContextText(value: string): string {
  return Array.from(value).slice(0, MAX_CONVERSATION_CONTEXT_TEXT_CODE_POINTS).join('');
}

export function conversationContextForTurns(
  turns: readonly ConversationTurn[],
): readonly ConversationContextTurn[] {
  // 文脈ウィンドウには直近の完了ターンだけを入れる。画面上の会話は削らず、
  // Providerへ繰り返し送る量だけを制限する。
  return turns
    .flatMap((turn): ConversationContextTurn[] => {
      const result = completedConversationResult(turn.translation);
      if (result === null) return [];
      return [
        {
          speaker: turn.direction === 'incoming' ? 'other' : 'self',
          sourceText: truncateContextText(turn.sourceText),
          translatedText: truncateContextText(result.translation),
        },
      ];
    })
    .slice(-MAX_CONVERSATION_CONTEXT_TURNS);
}

export function conversationReplyTargetLanguage(
  turns: readonly ConversationTurn[],
  initialTargetLanguage: string,
): string {
  for (const turn of [...turns].reverse()) {
    const result = completedConversationResult(turn.translation);
    if (result === null) continue;
    // 受信原文の言語、または最初に送信した翻訳先が、そのセッションの相手言語。
    // Providerが混在文を "Chinese (with English)" のような複合ラベルで返すことがある。
    // そのまま次のtargetLanguageへ渡すと二言語併記を促すため、主言語として先頭だけを使う。
    return primaryConversationLanguage(
      turn.direction === 'incoming' ? result.sourceLanguage : result.targetLanguage,
    );
  }
  return initialTargetLanguage;
}

function primaryConversationLanguage(language: string): string {
  const normalized = language.trim();
  const withoutParentheticalMixture = normalized.replace(
    /\s*\((?:mixed\s+)?(?:with|plus|and)\s+[^)]+\)\s*$/iu,
    '',
  );
  const [primary] = withoutParentheticalMixture.split(
    /\s+(?:(?:mixed\s+)?with|plus)\s+|\s*[/,+&]\s*/iu,
    1,
  );
  return primary?.trim() || normalized;
}
