import type { LlmProviderErrorCode } from '@fumu/llm-core';

// ユーザーが1回の翻訳で入力できる本文の上限。
// UTF-16 code unitではなくUnicode code pointで数え、絵文字を不当に2文字扱いしない。
export const MAX_TRANSLATION_SOURCE_CODE_POINTS = 100_000;
// Inline context is intentionally bounded separately from sourceText. It can improve disambiguation,
// but must never become a second, effectively unbounded prompt channel.
export const MAX_INLINE_TRANSLATION_CONTEXTS = 12;
export const MAX_INLINE_TRANSLATION_CONTEXT_CODE_POINTS = 120;
export const MAX_INLINE_TRANSLATION_CONTEXT_TOTAL_CODE_POINTS = 600;
// 会話履歴は現在の翻訳を助ける文脈であり、本文を際限なく複製する経路にはしない。
// 直近のターンに絞ることで、長い会話でもProvider入力と応答時間を予測可能に保つ。
export const MAX_CONVERSATION_CONTEXT_TURNS = 12;
export const MAX_CONVERSATION_CONTEXT_TEXT_CODE_POINTS = 4_000;
// 翻訳後の文章は言語や「詳しく」操作によって元文より長くなり得る。
// 再調整・戻し訳ではユーザー入力上限を流用せず、Provider入力の保護上限を使う。
export const MAX_TRANSLATION_TRANSFORM_SOURCE_CODE_POINTS = 100_000;
export const MIN_TRANSLATION_OUTPUT_TOKENS = 2_048;
export const MAX_TRANSLATION_OUTPUT_TOKENS = 8_192;

export type InlineTranslationContextValidationError =
  'empty' | 'too-many' | 'context-too-long' | 'total-too-long';

export type InlineTranslationContextValidation =
  | { readonly success: true; readonly value: readonly string[] }
  | { readonly success: false; readonly error: InlineTranslationContextValidationError };

export function normalizeInlineTranslationContext(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function validateInlineTranslationContexts(
  input: readonly string[],
): InlineTranslationContextValidation {
  const normalized: string[] = [];
  for (const value of input) {
    const context = normalizeInlineTranslationContext(value);
    if (context.length === 0) return { success: false, error: 'empty' };
    if (Array.from(context).length > MAX_INLINE_TRANSLATION_CONTEXT_CODE_POINTS) {
      return { success: false, error: 'context-too-long' };
    }
    if (!normalized.includes(context)) normalized.push(context);
  }
  if (normalized.length > MAX_INLINE_TRANSLATION_CONTEXTS) {
    return { success: false, error: 'too-many' };
  }
  const totalCodePoints = normalized.reduce(
    (total, context) => total + Array.from(context).length,
    0,
  );
  if (totalCodePoints > MAX_INLINE_TRANSLATION_CONTEXT_TOTAL_CODE_POINTS) {
    return { success: false, error: 'total-too-long' };
  }
  return { success: true, value: normalized };
}

export function truncateTranslationSourceText(sourceText: string): string {
  if (sourceText.length <= MAX_TRANSLATION_SOURCE_CODE_POINTS) return sourceText;
  return Array.from(sourceText).slice(0, MAX_TRANSLATION_SOURCE_CODE_POINTS).join('');
}

export function translationOutputTokenBudget(sourceText: string): number {
  const sourceCodePoints = Array.from(sourceText).length;
  // The response can contain the main translation plus three alternatives,
  // explanation, nuances, and JSON escaping. Eight tokens per source code point
  // leaves headroom for that structure while retaining a provider-neutral cap.
  return Math.min(
    MAX_TRANSLATION_OUTPUT_TOKENS,
    Math.max(MIN_TRANSLATION_OUTPUT_TOKENS, 1_024 + sourceCodePoints * 8),
  );
}

export interface TranslationAlternative {
  readonly text: string;
  readonly nuance: string;
}

export interface TranslationResult {
  readonly translation: string;
  readonly explanation: string;
  readonly alternatives: readonly TranslationAlternative[];
  /** Provider confirmed that materially different candidates are genuinely useful. */
  readonly alternativesNeeded?: boolean;
  /** Naturalness of the translated text being inspected by a blind back-translation. */
  readonly isNatural?: boolean;
  /** Whether an independent comparison of source and back translation retained meaning. */
  readonly meaningPreserved?: boolean;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

export interface TranslationSnapshot {
  readonly translation?: string;
  readonly explanation?: string;
  readonly alternatives?: readonly Readonly<Partial<TranslationAlternative>>[];
  readonly alternativesNeeded?: boolean;
  readonly isNatural?: boolean;
  readonly meaningPreserved?: boolean;
  readonly sourceLanguage?: string;
  readonly targetLanguage?: string;
}

export const TRANSLATION_ACTION_OPERATION_VALUES = [
  'casual',
  'polite',
  'shorter',
  'detailed',
  'plain',
  'catchy',
  'natural',
  'humanize',
  'alternatives',
  'back-translate',
] as const;
export type TranslationActionOperation = (typeof TRANSLATION_ACTION_OPERATION_VALUES)[number];

export const TRANSLATION_OPERATION_VALUES = [
  'translate',
  'writing-style',
  ...TRANSLATION_ACTION_OPERATION_VALUES,
] as const;
export type TranslationOperation = (typeof TRANSLATION_OPERATION_VALUES)[number];

export interface TranslationRequest {
  readonly requestId: string;
  readonly sourceText: string;
  /**
   * User-authored hints about subject, audience, medium, purpose, or situation.
   * These are prompt context only and are not part of sourceText or translation history.
   */
  readonly inlineContexts?: readonly string[];
  /**
   * Earlier messages in the same conversation. These are untrusted context only;
   * sourceText remains the sole message translated by the current request.
   */
  readonly conversationContext?: readonly ConversationContextTurn[];
  readonly sourceLanguage?: string;
  readonly targetLanguage?: string;
  /** Language used for explanations and nuance notes, independent from the translation target. */
  readonly explanationLanguage?: string;
  readonly languageRouting?: {
    readonly nativeLanguage: string;
    readonly otherLanguageTarget: string;
  };
  readonly translationStyle?: 'literal' | 'natural';
  readonly writingStyle?: {
    readonly name: string;
    readonly instruction: string;
  };
  readonly operation?: TranslationOperation;
  readonly currentResult?: TranslationResult;
  /** Opt-in diagnostic output. Raw provider text is exposed only to the local UI when enabled. */
  readonly debugMode?: boolean;
  readonly signal?: AbortSignal;
}

export interface ConversationContextTurn {
  readonly speaker: 'self' | 'other';
  readonly sourceText: string;
  readonly translatedText: string;
}

export type TranslationErrorCode = LlmProviderErrorCode | 'provider-not-configured';

export type TranslationEvent =
  | {
      readonly type: 'started';
      readonly requestId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: 'snapshot';
      readonly requestId: string;
      readonly sequence: number;
      readonly value: TranslationSnapshot;
    }
  | {
      readonly type: 'completed';
      readonly requestId: string;
      readonly value: TranslationResult;
      readonly completedAt: number;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }
  | {
      readonly type: 'failed';
      readonly requestId: string;
      readonly code: TranslationErrorCode;
      readonly message: string;
      readonly retryable: boolean;
      /** Raw provider text accumulated before the failure, present only in debug mode. */
      readonly debugResponse?: string;
    }
  | {
      readonly type: 'cancelled';
      readonly requestId: string;
    };

export interface TranslationService {
  translate(request: TranslationRequest): AsyncIterable<TranslationEvent>;
}

export interface FollowUpMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface FollowUpRequest {
  readonly requestId: string;
  readonly sourceText: string;
  readonly translation: TranslationResult;
  readonly messages: readonly FollowUpMessage[];
  readonly question: string;
  /** When set, the answer and its explanations must use this language. */
  readonly responseLanguage?: string;
  readonly signal?: AbortSignal;
}

export type FollowUpEvent =
  | {
      readonly type: 'started';
      readonly requestId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: 'snapshot';
      readonly requestId: string;
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: 'completed';
      readonly requestId: string;
      readonly text: string;
      readonly completedAt: number;
    }
  | {
      readonly type: 'failed';
      readonly requestId: string;
      readonly code: TranslationErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly type: 'cancelled';
      readonly requestId: string;
    };

export interface FollowUpService {
  ask(request: FollowUpRequest): AsyncIterable<FollowUpEvent>;
}
