import type { WritingStyle, WritingStyleInstruction } from '../../../shared/settings-contracts';

interface ComposeWritingStyleInput {
  readonly mode: 'text' | 'conversation';
  readonly enabled: boolean;
  readonly styles: readonly WritingStyle[];
  readonly additionalInstruction: string;
  readonly additionalInstructionLabel: string;
}

export function composeWritingStyleInstruction({
  enabled,
  styles,
  additionalInstruction,
  additionalInstructionLabel,
}: ComposeWritingStyleInput): WritingStyleInstruction | null {
  if (!enabled) return null;

  const additional = additionalInstruction.trim();
  if (styles.length === 0 && additional.length === 0) return null;

  return {
    name: [
      ...styles.map((style) => style.name),
      ...(additional.length > 0 ? [additionalInstructionLabel] : []),
    ].join(' + '),
    instruction: [
      ...styles.map((style) => `【${style.name}】\n${style.instruction}`),
      ...(additional.length > 0 ? [`【${additionalInstructionLabel}】\n${additional}`] : []),
    ].join('\n\n'),
  };
}
