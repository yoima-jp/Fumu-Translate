import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertRendererAccess, classifyRendererUrl, rendererEntryUrls } from './ipc-sender-policy';

describe('IPC sender policy', () => {
  it('accepts only the exact authorized window and main frame', () => {
    const expected = rendererEntryUrls(undefined, resolve('renderer/index.html'));

    expect(classifyRendererUrl(expected.main, expected)).toBe('main');
    expect(classifyRendererUrl('file:///C:/tmp/attacker.html?window=main', expected)).toBeNull();
    expect(() => assertRendererAccess(expected.main, false, expected, ['main'])).toThrow(
      'non-main frame',
    );
    expect(() => assertRendererAccess(expected.main, true, expected, ['popup'])).toThrow(
      'untrusted renderer',
    );
  });
});
