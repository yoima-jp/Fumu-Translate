import type { TranslationResult } from '@fumu/translation-core';
import { describe, expect, it } from 'vitest';
import type { ResolvedSelection } from '../../shared/contracts';
import { FumuDatabase } from './database';
import { HistoryRepository } from './history-repository';

const selection: ResolvedSelection = {
  text: 'source',
  programName: 'test.exe',
  method: 'uia',
  anchor: null,
  acquiredAt: 1,
};

function result(translation: string): TranslationResult {
  return {
    translation,
    explanation: '',
    alternatives: [],
    sourceLanguage: 'English',
    targetLanguage: 'Japanese',
  };
}

describe('HistoryRepository retention', () => {
  it('removes only sessions older than the configured cutoff', () => {
    const database = new FumuDatabase(':memory:');
    const history = new HistoryRepository(database);
    for (const [id, createdAt] of [
      ['00000000-0000-4000-8000-000000000021', 100],
      ['00000000-0000-4000-8000-000000000022', 200],
    ] as const) {
      history.recordTranslation({
        sessionId: id,
        requestId: `request-${String(createdAt)}`,
        selection,
        operation: 'translate',
        result: result(String(createdAt)),
        providerProfileId: null,
        providerName: null,
        createdAt,
      });
    }

    expect(history.purgeOlderThan(150)).toBe(1);
    expect(history.list('', 10)).toHaveLength(1);
    expect(history.get('00000000-0000-4000-8000-000000000021')).toBeNull();
    expect(history.get('00000000-0000-4000-8000-000000000022')).not.toBeNull();
    database.close();
  });
});
