import { describe, expect, it, vi } from 'vitest';
import { AppController, type AppControllerDependencies } from './app-controller';

vi.mock('electron-log/main', () => ({
  default: { scope: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('./os/selection/selection-hook-service', () => ({
  SelectionTextTooLargeError: class extends Error {},
}));

function createFixture(compactTranslation: boolean) {
  const clipboard = { readText: vi.fn().mockResolvedValue('previously copied text') };
  const selection = {
    isRunning: true,
    recentAnchor: vi.fn().mockReturnValue(null),
    resolveSelection: vi.fn().mockResolvedValue(null),
  };
  const translate = vi.fn();
  const popup = {
    isVisible: false,
    showCapturing: vi.fn(),
    showError: vi.fn(),
    showManual: vi.fn(),
    showSelection: vi.fn(),
    showSelectionInMain: vi.fn(),
    showErrorInMain: vi.fn(),
  };
  // この回帰テストでは初期化・永続化を行わず、選択失敗と明示的な
  // クリップボード読み取りに必要な境界だけを用意する。
  const dependencies = {
    clipboard,
    selection,
    translation: { translate },
    popup,
    hotkey: { registerTransient: vi.fn().mockReturnValue(true) },
    mainWindow: { showInactive: vi.fn(), sendStatus: vi.fn() },
    settings: { snapshot: { shortcut: 'Alt+J', compactTranslation } },
    providers: { configured: true, activeProviderName: null, activeModelName: null },
  } as unknown as AppControllerDependencies;
  return { controller: new AppController(dependencies), clipboard, selection, translate, popup };
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
    if (compact) {
      expect(fixture.popup.showError).toHaveBeenCalledWith(
        expect.any(String),
        '選択を取得できませんでした。',
      );
      expect(fixture.popup.showErrorInMain).not.toHaveBeenCalled();
    } else {
      expect(fixture.popup.showError).not.toHaveBeenCalled();
      expect(fixture.popup.showErrorInMain).toHaveBeenCalledWith(
        expect.any(String),
        '選択を取得できませんでした。',
      );
    }
  });

  it('does not read the clipboard when selection throws', async () => {
    const fixture = createFixture(true);
    fixture.selection.resolveSelection.mockRejectedValue(new Error('provider failure'));
    await fixture.controller.triggerSelection();
    expect(fixture.clipboard.readText).not.toHaveBeenCalled();
    expect(fixture.translate).not.toHaveBeenCalled();
    expect(fixture.popup.showError).toHaveBeenCalledOnce();
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
