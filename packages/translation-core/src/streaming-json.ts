import { LlmProviderError } from '@fumu/llm-core';
import { Allow, parse } from 'partial-json';
import { z } from 'zod';
import type { TranslationAlternative, TranslationResult, TranslationSnapshot } from './contracts';

const text = z.string().max(100_000);
// OpenAI互換Modelの一部は、指定したobject形式を無視して候補を文字列で返す。
// 候補の形式差だけで取得済みの翻訳本文を失わせず、ニュアンス欠落として正規化する。
const partialAlternativeSchema = z.union([
  text,
  z
    .object({
      text: text.optional(),
      nuance: text.optional(),
    })
    .strip(),
]);

const partialResultSchema = z
  .object({
    translation: text.optional(),
    explanation: text.optional(),
    alternativesNeeded: z.boolean().optional(),
    alternatives: z.array(partialAlternativeSchema).max(10).optional(),
    sourceLanguage: z.string().max(100).optional(),
    targetLanguage: z.string().max(100).optional(),
  })
  .strip();

const finalAlternativeSchema = z.union([
  z.string().max(50_000),
  z
    .object({
      text: z.string().max(50_000).optional(),
      nuance: z.string().max(50_000).optional(),
    })
    .strip(),
]);

const finalResultSchema = z
  .object({
    translation: z.string().trim().min(1).max(100_000),
    explanation: z
      .union([z.string().max(100_000), z.array(z.string().max(25_000)).max(8)])
      .optional(),
    alternatives: z.array(finalAlternativeSchema).max(10).optional(),
    alternativesNeeded: z.boolean().optional(),
    sourceLanguage: z.string().trim().min(1).max(100).optional(),
    targetLanguage: z.string().trim().min(1).max(100).optional(),
  })
  .strip();

function jsonCandidate(value: string): string | null {
  const start = value.indexOf('{');
  return start < 0 ? null : value.slice(start);
}

export function parsePartialTranslationJson(value: string): TranslationSnapshot | null {
  const candidate = jsonCandidate(value);
  if (candidate === null) {
    return null;
  }

  try {
    const parsed: unknown = parse(candidate, Allow.ALL);
    const result = partialResultSchema.safeParse(parsed);
    if (!result.success || Object.keys(result.data).length === 0) {
      return null;
    }

    const data = result.data;
    const alternatives = data.alternatives?.slice(0, 3).map((alternative) =>
      typeof alternative === 'string'
        ? { text: alternative }
        : {
            ...(alternative.text === undefined ? {} : { text: alternative.text }),
            ...(alternative.nuance === undefined ? {} : { nuance: alternative.nuance }),
          },
    );
    // exactOptionalPropertyTypes下では「存在しない」と「undefinedを持つ」を区別する。
    // Rendererへ不要なundefinedフィールドを送らず、差分判定も安定させる。
    return {
      ...(data.translation === undefined ? {} : { translation: data.translation }),
      ...(data.explanation === undefined ? {} : { explanation: data.explanation }),
      ...(data.alternativesNeeded === undefined
        ? {}
        : { alternativesNeeded: data.alternativesNeeded }),
      ...(alternatives === undefined ? {} : { alternatives }),
      ...(data.sourceLanguage === undefined ? {} : { sourceLanguage: data.sourceLanguage }),
      ...(data.targetLanguage === undefined ? {} : { targetLanguage: data.targetLanguage }),
    };
  } catch {
    // Streaming中の不完全なescapeや一時的な構文エラーは次のdeltaで回復し得る。
    return null;
  }
}

function extractFirstCompleteObject(value: string): string | null {
  const start = value.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

export interface FinalTranslationDefaults {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly operation?: string;
  readonly forceLanguageDefaults?: boolean;
}

function hasClosedTranslationString(value: string): boolean {
  const match = /"translation"\s*:\s*"/u.exec(value);
  if (match === null) return false;
  let escaped = false;
  for (let index = match.index + match[0].length; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return true;
    }
  }
  return false;
}

function normalizedResult(
  result: z.infer<typeof finalResultSchema>,
  defaults: FinalTranslationDefaults,
): TranslationResult {
  const alternativesNeeded =
    defaults.operation === 'alternatives' || result.alternativesNeeded === true;
  const alternatives = normalizedAlternatives(result.alternatives, alternativesNeeded);
  const explanation = Array.isArray(result.explanation)
    ? result.explanation
        .map((item) => item.trim())
        .filter(Boolean)
        .join('\n')
    : (result.explanation?.trim() ?? '');
  return {
    translation: result.translation,
    explanation,
    alternatives,
    alternativesNeeded,
    sourceLanguage: defaults.forceLanguageDefaults
      ? defaults.sourceLanguage
      : (result.sourceLanguage ?? defaults.sourceLanguage),
    targetLanguage: defaults.forceLanguageDefaults
      ? defaults.targetLanguage
      : (result.targetLanguage ?? defaults.targetLanguage),
  };
}

type AlternativeInput =
  | string
  | {
      readonly text?: string | undefined;
      readonly nuance?: string | undefined;
    };

function normalizedAlternatives(
  alternatives: readonly AlternativeInput[] | undefined,
  alternativesNeeded: boolean,
): readonly TranslationAlternative[] {
  if (!alternativesNeeded) return [];
  return (alternatives ?? [])
    .flatMap((alternative) => {
      if (typeof alternative === 'string') {
        const alternativeText = alternative.trim();
        return alternativeText ? [{ text: alternativeText, nuance: '' }] : [];
      }
      const alternativeText = alternative.text?.trim();
      const nuance = alternative.nuance?.trim();
      return alternativeText && nuance ? [{ text: alternativeText, nuance }] : [];
    })
    .slice(0, 3);
}

export function parseFinalTranslationJson(
  value: string,
  defaults: FinalTranslationDefaults,
): TranslationResult {
  try {
    const objectText = extractFirstCompleteObject(value);
    if (objectText === null) {
      throw new Error('No complete JSON object was returned.');
    }

    const result = finalResultSchema.parse(JSON.parse(objectText));
    // 本文を正常に返したProvider応答を、任意メタデータの欠落だけで失敗させない。
    // 不完全な候補は捨て、解説配列はUIが扱う改行区切り文字列へ正規化する。
    return normalizedResult(result, defaults);
  } catch (error) {
    throw new LlmProviderError('The provider returned invalid translation JSON.', {
      code: 'invalid-response',
      retryable: true,
      cause: error,
    });
  }
}

export function recoverCompletedTranslation(
  value: string,
  defaults: FinalTranslationDefaults,
): TranslationResult | null {
  if (!hasClosedTranslationString(value)) return null;
  const candidate = jsonCandidate(value);
  if (candidate === null) return null;
  try {
    const partial: unknown = parse(candidate, Allow.ALL);
    const recovered = partialResultSchema.safeParse(partial);
    if (!recovered.success) return null;
    const translation = recovered.data.translation?.trim();
    if (!translation) return null;
    const explanation = recovered.data.explanation?.trim() ?? '';
    const alternativesNeeded = recovered.data.alternativesNeeded === true;
    const alternatives = normalizedAlternatives(recovered.data.alternatives, alternativesNeeded);
    // 本文のJSON文字列が閉じている場合だけ救済する。途中で切れた本文を完成扱いせず、
    // 本文後の解説・候補・usageで接続が切れたケースに回復範囲を限定する。
    // ここで本文だけを返すと、Streaming中に表示できていた解説が完了時に消えるため、
    // 取得済みで完全なメタデータも安全な範囲で引き継ぐ。
    return {
      translation,
      explanation,
      alternatives,
      alternativesNeeded,
      sourceLanguage: recovered.data.sourceLanguage?.trim() || defaults.sourceLanguage,
      targetLanguage: recovered.data.targetLanguage?.trim() || defaults.targetLanguage,
    };
  } catch {
    return null;
  }
}
