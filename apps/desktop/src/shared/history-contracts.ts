import type { TranslationOperation, TranslationResult } from '@fumu/translation-core';
import type { SelectionMethod } from './contracts';
import type { AppliedTranslationInstruction } from './applied-translation-instructions-contract';

export interface HistoryListItem {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sourceText: string;
  readonly translation: string;
  readonly providerName: string | null;
  readonly modelId: string | null;
}

export interface HistoryResultView {
  readonly id: string;
  readonly requestId: string;
  readonly operation: TranslationOperation;
  readonly writingStyleName?: string;
  readonly appliedInstructions?: readonly AppliedTranslationInstruction[];
  readonly sourceText: string;
  readonly conversationDirection?: 'incoming' | 'outgoing';
  readonly value: TranslationResult;
  readonly providerName: string | null;
  readonly modelId: string | null;
  readonly createdAt: number;
}

export interface HistoryMessageView {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: number;
}

export interface HistoryDetail {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sourceText: string;
  readonly programName: string | null;
  readonly selectionMethod: SelectionMethod;
  readonly results: readonly HistoryResultView[];
  readonly messages: readonly HistoryMessageView[];
}

export interface HistoryQuery {
  readonly query: string;
  readonly limit: number;
}
