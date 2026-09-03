import type {
  NativeLanguage,
  OtherLanguageTarget,
  SettingsSnapshot,
} from '../../../shared/settings-contracts';
import { distinctTranslationTarget } from '../../../shared/settings-contracts';

type LanguageSettings = Pick<SettingsSnapshot, 'nativeLanguage' | 'otherLanguageTarget'>;

/** The selector is the target used when the source is written in the user's language. */
export function displayedTargetLanguage(settings: LanguageSettings | null): NativeLanguage {
  return settings === null
    ? 'Japanese'
    : distinctTranslationTarget(settings.nativeLanguage, settings.otherLanguageTarget);
}

/** Normalize either selector without leaving a no-op source/target combination. */
export function targetAfterNativeLanguageChange(
  nativeLanguage: NativeLanguage | null,
  currentTarget: OtherLanguageTarget,
): OtherLanguageTarget {
  return distinctTranslationTarget(nativeLanguage, currentTarget);
}
