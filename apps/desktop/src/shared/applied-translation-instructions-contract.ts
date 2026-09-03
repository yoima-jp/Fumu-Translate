export const MAX_APPLIED_TRANSLATION_INSTRUCTIONS = 24;
// 追加指示の入力上限と揃え、履歴には実際に使った本文を欠落なく残す。
// UI側はchip幅を制限し、長文はhoverで全文を確認できる。
export const MAX_APPLIED_TRANSLATION_INSTRUCTION_CODE_POINTS = 10_000;

export const APPLIED_TRANSLATION_INSTRUCTION_KIND_VALUES = ['context', 'writing-style'] as const;
export type AppliedTranslationInstructionKind =
  (typeof APPLIED_TRANSLATION_INSTRUCTION_KIND_VALUES)[number];

export interface AppliedTranslationInstruction {
  readonly kind: AppliedTranslationInstructionKind;
  readonly label: string;
}

export function normalizeAppliedTranslationInstructionLabel(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const codePoints = Array.from(normalized);
  if (codePoints.length <= MAX_APPLIED_TRANSLATION_INSTRUCTION_CODE_POINTS) return normalized;
  return `${codePoints.slice(0, MAX_APPLIED_TRANSLATION_INSTRUCTION_CODE_POINTS - 1).join('')}…`;
}
