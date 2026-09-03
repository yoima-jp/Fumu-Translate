import type { WritingStyle } from '../../../shared/settings-contracts';
import {
  normalizeAppliedTranslationInstructionLabel,
  type AppliedTranslationInstruction,
} from '../../../shared/applied-translation-instructions-contract';

export type { AppliedTranslationInstruction } from '../../../shared/applied-translation-instructions-contract';

interface AppliedTranslationInstructionsInput {
  readonly inlineContexts: readonly string[];
  readonly writingStyles: readonly WritingStyle[];
  readonly additionalInstruction: string;
}

export function appliedTranslationInstructions({
  inlineContexts,
  writingStyles,
  additionalInstruction,
}: AppliedTranslationInstructionsInput): readonly AppliedTranslationInstruction[] {
  const additional = normalizeAppliedTranslationInstructionLabel(additionalInstruction);
  return [
    ...inlineContexts.map((label): AppliedTranslationInstruction => ({
      kind: 'context',
      label: normalizeAppliedTranslationInstructionLabel(label),
    })),
    ...writingStyles.map((style): AppliedTranslationInstruction => ({
      kind: 'writing-style',
      label: normalizeAppliedTranslationInstructionLabel(style.name),
    })),
    ...(additional.length === 0
      ? []
      : ([
          { kind: 'writing-style', label: additional },
        ] satisfies readonly AppliedTranslationInstruction[])),
  ];
}
