import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  MAX_TRANSLATION_SOURCE_CODE_POINTS,
  truncateTranslationSourceText,
} from '@fumu/translation-core';
import type { PopupViewState } from '../../shared/contracts';
import { TranslationResultPanel } from './TranslationResultPanel';
import { FumuMascot } from './FumuMascot';
import { I18nProvider, useI18n } from './i18n';

// Popupはショートカット後すぐ起動する。設定・履歴・オンボーディングを含む
// MainViewを別chunkにし、Popup processが不要な画面全体をparseしないようにする。
const MainView = lazy(async () => {
  const module = await import('./main-window/MainView');
  return { default: module.MainView };
});

const INITIAL_POPUP_STATE: PopupViewState = { phase: 'idle', requestId: null };

function usePopupState(): PopupViewState {
  const [state, setState] = useState<PopupViewState>(INITIAL_POPUP_STATE);
  useEffect(() => window.fumu.onPopupState(setState), []);
  return state;
}

function usePopupTheme(phase: PopupViewState['phase']): void {
  useEffect(() => {
    let active = true;
    void window.fumu
      .getSettings()
      .then((settings) => {
        if (active) document.documentElement.dataset.theme = settings.appearance;
      })
      .catch(() => undefined);
    const unsubscribe = window.fumu.onSettingsChanged((settings) => {
      document.documentElement.dataset.theme = settings.appearance;
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [phase]);
}

function usePopupResize(
  elementRef: React.RefObject<HTMLElement | null>,
  state: PopupViewState,
): void {
  useEffect(() => {
    const element = elementRef.current;
    if (element === null || state.phase === 'idle') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = element.getBoundingClientRect();
        void window.fumu.resizePopup({
          width: Math.ceil(bounds.width),
          height: Math.ceil(bounds.height),
        });
      });
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [elementRef, state]);
}

function PopupHeader(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <header className="popup-header">
      <span className="popup-brand">
        <span className="popup-mascot" aria-hidden="true">
          <FumuMascot />
        </span>
        Fumu!
      </span>
      <button
        type="button"
        className="icon-button no-drag"
        aria-label={t('popup.close')}
        onClick={() => void window.fumu.closePopup()}
      >
        <X size={17} />
      </button>
    </header>
  );
}

function ManualContent({ clipboardText }: { readonly clipboardText: string | null }) {
  const { t } = useI18n();
  const [text, setText] = useState(clipboardText ?? '');
  return (
    <form
      className="manual-section"
      onSubmit={(event) => {
        event.preventDefault();
        const value = text.trim();
        if (value) void window.fumu.useManualText(value);
      }}
    >
      <label htmlFor="manual-source">{t('popup.sourceLabel')}</label>
      <textarea
        id="manual-source"
        data-testid="popup-source-input"
        value={text}
        // maxLengthはUTF-16単位なので、絵文字100,000文字を入力できる余地を残し、
        // onChange側でcode point上限へ正規化する。
        maxLength={MAX_TRANSLATION_SOURCE_CODE_POINTS * 2}
        autoFocus
        placeholder={t('popup.sourcePlaceholder')}
        onChange={(event) => setText(truncateTranslationSourceText(event.currentTarget.value))}
      />
      <button className="translate-button" type="submit" disabled={!text.trim()}>
        {t('popup.translate')}
      </button>
    </form>
  );
}

function PopupView(): React.JSX.Element {
  const { t } = useI18n();
  const state = usePopupState();
  const popupRef = useRef<HTMLElement>(null);
  usePopupTheme(state.phase);
  usePopupResize(popupRef, state);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void window.fumu.closePopup();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <article ref={popupRef} className="popup-shell" data-popup-root>
      <PopupHeader />

      {state.phase === 'capturing' && (
        <section className="capture-state" aria-busy="true">
          <span className="sr-only">{t('popup.capturing')}</span>
          <div className="nani-loading-lines" aria-hidden="true">
            <span />
            <span />
          </div>
        </section>
      )}

      {state.phase === 'selection' && (
        <div className="popup-scroll">
          <TranslationResultPanel
            sourceText={state.selection.text}
            translation={state.translation}
            followUpMessages={state.followUpMessages}
            compact
          />
        </div>
      )}

      {state.phase === 'manual' && <ManualContent clipboardText={state.clipboardText} />}

      {state.phase === 'error' && (
        <section className="error-state" role="alert">
          <p>{t('popup.selectionError')}</p>
          <button
            className="translate-button"
            type="button"
            onClick={() => void window.fumu.triggerClipboard()}
          >
            {t('popup.openClipboard')}
          </button>
        </section>
      )}
    </article>
  );
}

export function App(): React.JSX.Element {
  return (
    <I18nProvider>
      <LocalizedApp />
    </I18nProvider>
  );
}

function LocalizedApp(): React.JSX.Element {
  const windowKind = new URLSearchParams(window.location.search).get('window');
  return windowKind === 'popup' ? (
    <PopupView />
  ) : (
    <Suspense fallback={null}>
      <MainView />
    </Suspense>
  );
}
