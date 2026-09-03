import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  TRANSLATION_OPERATION_VALUES,
  type TranslationOperation,
  type TranslationResult,
} from '@fumu/translation-core';
import type {
  HistoryDetail,
  HistoryListItem,
  HistoryMessageView,
  HistoryResultView,
} from '../../shared/history-contracts';
import { SELECTION_METHOD_VALUES, type ResolvedSelection } from '../../shared/contracts';
import {
  APPLIED_TRANSLATION_INSTRUCTION_KIND_VALUES,
  MAX_APPLIED_TRANSLATION_INSTRUCTION_CODE_POINTS,
  MAX_APPLIED_TRANSLATION_INSTRUCTIONS,
  type AppliedTranslationInstruction,
} from '../../shared/applied-translation-instructions-contract';
import type { FumuDatabase } from './database';

const translationResultSchema = z
  .object({
    translation: z.string().max(200_000),
    explanation: z.string().max(200_000),
    alternatives: z
      .array(z.object({ text: z.string().max(200_000), nuance: z.string().max(200_000) }).strict())
      .max(20),
    alternativesNeeded: z.boolean().optional(),
    isNatural: z.boolean().optional(),
    meaningPreserved: z.boolean().optional(),
    sourceLanguage: z.string().max(200),
    targetLanguage: z.string().max(200),
    writingStyleName: z.string().max(80).optional(),
    appliedInstructions: z
      .array(
        z
          .object({
            kind: z.enum(APPLIED_TRANSLATION_INSTRUCTION_KIND_VALUES),
            label: z.string().max(MAX_APPLIED_TRANSLATION_INSTRUCTION_CODE_POINTS * 2),
          })
          .strict(),
      )
      .max(MAX_APPLIED_TRANSLATION_INSTRUCTIONS)
      .optional(),
  })
  .strict();

const operationSchema = z.enum(TRANSLATION_OPERATION_VALUES);

const selectionMethodSchema = z.enum(SELECTION_METHOD_VALUES);

interface SessionListRow {
  readonly id: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly source_text: string;
  readonly result_json: string;
  readonly provider_name: string | null;
  readonly provider_model_id: string | null;
}

interface SessionRow {
  readonly id: string;
  readonly source_text: string;
  readonly program_name: string | null;
  readonly selection_method: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ResultRow {
  readonly id: string;
  readonly request_id: string;
  readonly operation: string;
  readonly result_json: string;
  readonly provider_name: string | null;
  readonly provider_model_id: string | null;
  readonly source_text: string | null;
  readonly conversation_direction: string | null;
  readonly created_at: number;
}

interface MessageRow {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly created_at: number;
}

export interface RecordTranslationInput {
  readonly sessionId: string;
  readonly requestId: string;
  readonly selection: ResolvedSelection;
  readonly operation: TranslationOperation;
  readonly writingStyleName?: string;
  readonly appliedInstructions?: readonly AppliedTranslationInstruction[];
  readonly conversationDirection?: 'incoming' | 'outgoing' | null;
  readonly result: TranslationResult;
  readonly providerProfileId: string | null;
  readonly providerName: string | null;
  readonly modelId?: string | null;
  readonly createdAt: number;
}

export interface RecordFollowUpInput {
  readonly sessionId: string;
  readonly selection: ResolvedSelection;
  readonly question: string;
  readonly answer: string;
  readonly createdAt: number;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

interface ParsedStoredResult {
  readonly value: TranslationResult;
  readonly writingStyleName?: string;
  readonly appliedInstructions?: readonly AppliedTranslationInstruction[];
}

function parseStoredResult(json: string): ParsedStoredResult {
  try {
    const result = translationResultSchema.parse(JSON.parse(json));
    // alternativesNeeded導入前の履歴は候補自体が「表示する」と判断された結果だった。
    // 新規結果の厳しいゲートには影響させず、旧行だけ保存済み候補の有無から補完する。
    const alternativesNeeded = result.alternativesNeeded ?? result.alternatives.length > 0;
    return {
      value: {
        translation: result.translation,
        explanation: result.explanation,
        alternatives: result.alternatives,
        alternativesNeeded,
        ...(result.isNatural === undefined ? {} : { isNatural: result.isNatural }),
        ...(result.meaningPreserved === undefined
          ? {}
          : { meaningPreserved: result.meaningPreserved }),
        sourceLanguage: result.sourceLanguage,
        targetLanguage: result.targetLanguage,
      },
      ...(result.writingStyleName === undefined
        ? {}
        : { writingStyleName: result.writingStyleName }),
      ...(result.appliedInstructions === undefined
        ? {}
        : { appliedInstructions: result.appliedInstructions }),
    };
  } catch (error) {
    throw new Error('A stored translation result is invalid.', { cause: error });
  }
}

function parseResult(json: string): TranslationResult {
  return parseStoredResult(json).value;
}

export class HistoryRepository {
  readonly #database: FumuDatabase;

  constructor(database: FumuDatabase) {
    this.#database = database;
  }

  recordTranslation(input: RecordTranslationInput): void {
    const result = translationResultSchema.parse(input.result);
    this.#database.transaction(() => {
      this.#upsertSession(input.sessionId, input.selection, input.createdAt);
      this.#database.connection
        .prepare(
          `INSERT OR IGNORE INTO translation_results
             (id, session_id, request_id, operation, result_json,
              provider_profile_id, provider_name, provider_model_id, source_text,
              conversation_direction, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.sessionId,
          input.requestId,
          input.operation,
          JSON.stringify({
            ...result,
            ...(input.writingStyleName === undefined
              ? {}
              : { writingStyleName: input.writingStyleName }),
            ...(input.appliedInstructions === undefined || input.appliedInstructions.length === 0
              ? {}
              : { appliedInstructions: input.appliedInstructions }),
          }),
          input.providerProfileId,
          input.providerName,
          input.modelId ?? null,
          input.selection.text,
          input.conversationDirection ?? null,
          input.createdAt,
        );
      this.#touchSession(input.sessionId, input.createdAt);
    });
  }

  recordFollowUp(input: RecordFollowUpInput): void {
    this.#database.transaction(() => {
      this.#upsertSession(input.sessionId, input.selection, input.createdAt);
      const statement = this.#database.connection.prepare(
        `INSERT INTO follow_up_messages (id, session_id, role, text, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      statement.run(randomUUID(), input.sessionId, 'user', input.question, input.createdAt);
      statement.run(randomUUID(), input.sessionId, 'assistant', input.answer, input.createdAt + 1);
      this.#touchSession(input.sessionId, input.createdAt + 1);
    });
  }

  list(query: string, limit: number): readonly HistoryListItem[] {
    const normalizedQuery = query.trim();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const filter = `%${escapeLike(normalizedQuery)}%`;
    const rows = this.#database.connection
      .prepare(
        `SELECT
           s.id,
           s.created_at,
           s.updated_at,
           s.source_text,
           r.result_json,
           r.provider_name,
           r.provider_model_id
         FROM translation_sessions s
         JOIN translation_results r ON r.rowid = (
           SELECT latest.rowid
           FROM translation_results latest
           WHERE latest.session_id = s.id AND latest.operation != 'back-translate'
           ORDER BY latest.created_at DESC, latest.rowid DESC
           LIMIT 1
         )
         WHERE (
           ? = '' OR EXISTS (
             SELECT 1
             FROM translation_results searched
             WHERE searched.session_id = s.id
               AND (
                 COALESCE(searched.source_text, s.source_text) LIKE ? ESCAPE '\\'
                 OR searched.result_json LIKE ? ESCAPE '\\'
               )
           )
         )
         ORDER BY s.updated_at DESC, s.id DESC
         LIMIT ?`,
      )
      .all(normalizedQuery, filter, filter, boundedLimit) as unknown as readonly SessionListRow[];

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sourceText: row.source_text,
      translation: parseResult(row.result_json).translation,
      providerName: row.provider_name,
      modelId: row.provider_model_id,
    }));
  }

  get(historyId: string): HistoryDetail | null {
    const session = this.#database.connection
      .prepare(
        `SELECT id, source_text, program_name, selection_method, created_at, updated_at
         FROM translation_sessions WHERE id = ?`,
      )
      .get(historyId) as SessionRow | undefined;
    if (session === undefined) {
      return null;
    }

    const resultRows = this.#database.connection
      .prepare(
        `SELECT id, request_id, operation, result_json, provider_name, provider_model_id,
                source_text, conversation_direction, created_at
         FROM translation_results
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(historyId) as unknown as readonly ResultRow[];
    const messageRows = this.#database.connection
      .prepare(
        `SELECT id, role, text, created_at
         FROM follow_up_messages
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(historyId) as unknown as readonly MessageRow[];

    const results: HistoryResultView[] = resultRows.map((row) => {
      const stored = parseStoredResult(row.result_json);
      return {
        id: row.id,
        requestId: row.request_id,
        operation: operationSchema.parse(row.operation),
        ...(stored.writingStyleName === undefined
          ? {}
          : { writingStyleName: stored.writingStyleName }),
        ...(stored.appliedInstructions === undefined
          ? {}
          : { appliedInstructions: stored.appliedInstructions }),
        sourceText: row.source_text ?? session.source_text,
        ...(row.conversation_direction === null
          ? {}
          : {
              conversationDirection: z
                .enum(['incoming', 'outgoing'])
                .parse(row.conversation_direction),
            }),
        value: stored.value,
        providerName: row.provider_name,
        modelId: row.provider_model_id,
        createdAt: row.created_at,
      };
    });
    const messages: HistoryMessageView[] = messageRows.map((row) => ({
      id: row.id,
      role: z.enum(['user', 'assistant']).parse(row.role),
      text: row.text,
      createdAt: row.created_at,
    }));

    return {
      id: session.id,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      sourceText: session.source_text,
      programName: session.program_name,
      selectionMethod: selectionMethodSchema.parse(session.selection_method),
      results,
      messages,
    };
  }

  delete(historyId: string): void {
    this.#database.connection
      .prepare('DELETE FROM translation_sessions WHERE id = ?')
      .run(historyId);
  }

  clear(): void {
    this.#database.connection.prepare('DELETE FROM translation_sessions').run();
  }

  purgeOlderThan(cutoff: number): number {
    if (!Number.isFinite(cutoff)) {
      throw new Error('History retention cutoff must be finite.');
    }
    const result = this.#database.connection
      .prepare('DELETE FROM translation_sessions WHERE updated_at < ?')
      .run(Math.trunc(cutoff));
    return Number(result.changes);
  }

  #upsertSession(sessionId: string, selection: ResolvedSelection, createdAt: number): void {
    this.#database.connection
      .prepare(
        `INSERT INTO translation_sessions
           (id, source_text, program_name, selection_method, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        sessionId,
        selection.text,
        selection.programName,
        selection.method,
        createdAt,
        createdAt,
      );
  }

  #touchSession(sessionId: string, updatedAt: number): void {
    this.#database.connection
      .prepare('UPDATE translation_sessions SET updated_at = ? WHERE id = ?')
      .run(updatedAt, sessionId);
  }
}
