import { DEFAULT_WRITING_STYLES, type WritingStyle } from '../../../shared/settings-contracts';
import { enMessages, jaMessages, type MessageKey } from './catalog';

type Translate = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

type BuiltInStyleSuffix =
  | '101'
  | '102'
  | '103'
  | '104'
  | '105'
  | '106'
  | '107'
  | '108'
  | '110'
  | '111'
  | '112'
  | '113'
  | '114'
  | '115'
  | '116'
  | '117'
  | '118';

const BUILT_IN_STYLE_SUFFIXES: Readonly<Record<string, BuiltInStyleSuffix>> = {
  '00000000-0000-4000-8000-000000000101': '101',
  '00000000-0000-4000-8000-000000000102': '102',
  '00000000-0000-4000-8000-000000000103': '103',
  '00000000-0000-4000-8000-000000000104': '104',
  '00000000-0000-4000-8000-000000000105': '105',
  '00000000-0000-4000-8000-000000000106': '106',
  '00000000-0000-4000-8000-000000000107': '107',
  '00000000-0000-4000-8000-000000000108': '108',
  '00000000-0000-4000-8000-000000000110': '110',
  '00000000-0000-4000-8000-000000000111': '111',
  '00000000-0000-4000-8000-000000000112': '112',
  '00000000-0000-4000-8000-000000000113': '113',
  '00000000-0000-4000-8000-000000000114': '114',
  '00000000-0000-4000-8000-000000000115': '115',
  '00000000-0000-4000-8000-000000000116': '116',
  '00000000-0000-4000-8000-000000000117': '117',
  '00000000-0000-4000-8000-000000000118': '118',
};

export function localizedWritingStyle(style: WritingStyle, t: Translate): WritingStyle {
  const suffix = BUILT_IN_STYLE_SUFFIXES[style.id];
  if (suffix === undefined) return style;
  return {
    ...style,
    name: t(`style.${suffix}.name`),
    description: t(`style.${suffix}.description`),
  };
}

export function localizedWritingStyles(
  styles: readonly WritingStyle[],
  t: Translate,
): readonly WritingStyle[] {
  return styles.map((style) => localizedWritingStyle(style, t));
}

export function localizedWritingStyleName(name: string, t: Translate): string {
  const nameKeys = Object.values(BUILT_IN_STYLE_SUFFIXES).map(
    (suffix) => `style.${suffix}.name` as const,
  );
  const defaultNames = new Map<string, BuiltInStyleSuffix>(
    DEFAULT_WRITING_STYLES.flatMap((style) => {
      const suffix = BUILT_IN_STYLE_SUFFIXES[style.id];
      return suffix === undefined ? [] : [[style.name, suffix] as const];
    }),
  );
  return name
    .split(' + ')
    .map((part) => {
      const defaultSuffix = defaultNames.get(part);
      if (defaultSuffix !== undefined) return t(`style.${defaultSuffix}.name`);
      const key = nameKeys.find(
        (candidate) => enMessages[candidate] === part || jaMessages[candidate] === part,
      );
      if (key !== undefined) return t(key);
      if (
        part === enMessages['main.additionalInstruction'] ||
        part === jaMessages['main.additionalInstruction']
      ) {
        return t('main.additionalInstruction');
      }
      return part;
    })
    .join(' + ');
}
