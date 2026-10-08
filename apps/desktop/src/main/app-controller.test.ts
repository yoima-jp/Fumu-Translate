import { describe, expect, it, vi } from 'vitest';
import type { TranslationRequest } from '@fumu/translation-core';
import type { ResolvedSelection } from '../shared/contracts';
import { AppController, type AppControllerDependencies } from './app-controller';

vi.mock('electron-log/main', () => ({
  default: { scope: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('./os/selection/selection-hook-service', () => ({
  SelectionTextTooLargeError: class extends Error {},
}));

function createFixture(compactTranslation: boolean) {
  const clipboard = { readText: vi.fn().mockResolvedValue('previously copied text') };
  const resolveSelection = vi.fn<() => Promise<ResolvedSelection | null>>().mockResolvedValue(null);
  const selection = {
    isRunning: true,
    recentAnchor: vi.fn().mockReturnValue(null),
    resolveSelection,
  };
  const translate = vi.fn(async function* (_request: TranslationRequest) {});
  const popup = {
    isVisible: false,
    showCapturing: vi.fn(),
    showError: vi.fn(),
    showManual: vi.fn(),
    showManualInMain: vi.fn(),
    showSelection: vi.fn(),
    showSelectionInMain: vi.fn(),
    showErrorInMain: vi.fn(),
    showTranslationEvent: vi.fn(),
  };
  // この回帰テストでは初期化・永続化を行わず、選択失敗と明示的な
  // クリップボード読み取りに必要な境界だけを用意する。
  const dependencies = {
    clipboard,
    selection,
    translation: { translate },
    popup,
    hotkey: { registerTransient: vi.fn().mockReturnValue(true) },
    mainWindow: { show: vi.fn(), showInactive: vi.fn(), sendStatus: vi.fn() },
    settings: {
      snapshot: {
        shortcut: 'Alt+J',
        compactTranslation,
        nativeLanguage: 'Japanese',
        otherLanguageTarget: 'English',
        historyEnabled: false,
        translationStyle: 'natural',
        developerMode: false,
        debugMode: false,
      },
    },
    providers: { configured: true, activeProviderName: null, activeModelName: null },
  } as unknown as AppControllerDependencies;
  return { controller: new AppController(dependencies), clipboard, selection, translate, popup };
}

function resolvedSelection(text: string): ResolvedSelection {
  return {
    text,
    programName: 'browser.exe',
    method: 'uia',
    anchor: null,
    acquiredAt: Date.now(),
  };
}

describe('selection failure does not translate stale clipboard text', () => {
  it.each([true, false])('does not read the clipboard (compact=%s)', async (compact) => {
    const fixture = createFixture(compact);
    await fixture.controller.triggerSelection();

    expect(fixture.selection.resolveSelection).toHaveBeenCalledOnce();
    expect(fixture.clipboard.readText).not.toHaveBeenCalled();
    expect(fixture.translate).not.toHaveBeenCalled();
    expect(fixture.popup.showSelection).not.toHaveBeenCalled();
    expect(fixture.popup.showSelectionInMain).not.toHaveBeenCalled();
    // 選択を読めなかったときは、クリップボードではなく手入力欄を出す。
    expect(fixture.popup.showError).not.toHaveBeenCalled();
    if (compact) {
      expect(fixture.popup.showManual).toHaveBeenCalledWith(expect.any(String), null);
      expect(fixture.popup.showManualInMain).not.toHaveBeenCalled();
    } else {
      expect(fixture.popup.showManual).not.toHaveBeenCalled();
      expect(fixture.popup.showManualInMain).toHaveBeenCalledWith(expect.any(String));
    }
  });

  it('does not read the clipboard when selection throws', async () => {
    const fixture = createFixture(true);
    fixture.selection.resolveSelection.mockRejectedValue(new Error('provider failure'));
    await fixture.controller.triggerSelection();
    expect(fixture.clipboard.readText).not.toHaveBeenCalled();
    expect(fixture.translate).not.toHaveBeenCalled();
    expect(fixture.popup.showManual).toHaveBeenCalledOnce();
  });

  it('still reads the clipboard when explicitly requested', async () => {
    const fixture = createFixture(true);
    fixture.clipboard.readText.mockResolvedValue(null);
    await fixture.controller.triggerClipboard();
    expect(fixture.clipboard.readText).toHaveBeenCalledOnce();
    expect(fixture.selection.resolveSelection).not.toHaveBeenCalled();
    expect(fixture.popup.showManual).toHaveBeenCalledWith(expect.any(String), null);
  });
});

describe('shortcut automatic target language', () => {
  it('sends an explicit Japanese target for text known not to be Japanese', async () => {
    const fixture = createFixture(true);
    fixture.selection.resolveSelection.mockResolvedValue(
      resolvedSelection('Some Minecraft versions include compatibility support.'),
    );

    await fixture.controller.triggerSelection();

    expect(fixture.translate).toHaveBeenCalledWith(
      expect.objectContaining({ targetLanguage: 'Japanese' }),
    );
    expect(fixture.translate.mock.calls[0]?.[0].languageRouting).toBeUndefined();
  });

  it('sends the configured counterpart for text containing Japanese kana', async () => {
    const fixture = createFixture(true);
    fixture.selection.resolveSelection.mockResolvedValue(
      resolvedSelection('これは日本語の文章です。'),
    );

    await fixture.controller.triggerSelection();

    expect(fixture.translate).toHaveBeenCalledWith(
      expect.objectContaining({ targetLanguage: 'English' }),
    );
    expect(fixture.translate.mock.calls[0]?.[0].languageRouting).toBeUndefined();
  });

  it('keeps provider routing for Han-only text that may be Japanese or Chinese', async () => {
    const fixture = createFixture(true);
    fixture.selection.resolveSelection.mockResolvedValue(resolvedSelection('互換性'));

    await fixture.controller.triggerSelection();

    expect(fixture.translate).toHaveBeenCalledWith(
      expect.objectContaining({
        languageRouting: {
          nativeLanguage: 'Japanese',
          otherLanguageTarget: 'English',
        },
      }),
    );
    expect(fixture.translate.mock.calls[0]?.[0].targetLanguage).toBeUndefined();
  });
});
