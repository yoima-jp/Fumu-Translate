import type { TranslationOperation } from '@fumu/translation-core';
import { enMessages, type MessageKey } from './en';
import { jaMessages } from './ja';

// Keep this as the stable import boundary for renderer code. New locales only
// need a catalog module and one entry in this map.
export { enMessages } from './en';
export { jaMessages } from './ja';
export type { MessageKey } from './en';

export const catalogs = { en: enMessages, ja: jaMessages } as const;

export const operationMessageKeys: Readonly<Record<TranslationOperation, MessageKey>> = {
  translate: 'operation.translate',
  'writing-style': 'operation.writing-style',
  casual: 'operation.casual',
  polite: 'operation.polite',
  shorter: 'operation.shorter',
  detailed: 'operation.detailed',
  plain: 'operation.plain',
  catchy: 'operation.catchy',
  natural: 'operation.natural',
  humanize: 'operation.humanize',
  alternatives: 'operation.alternatives',
  'back-translate': 'operation.back-translate',
};
