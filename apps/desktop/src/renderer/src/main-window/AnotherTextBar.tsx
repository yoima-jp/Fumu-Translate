import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Image as ImageIcon,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  X,
} from 'lucide-react';
import type { SettingsSnapshot, WritingStyle } from '../../../shared/settings-contracts';
import { FIXED_ADJUSTMENT_STYLE_IDS } from '../../../shared/settings-contracts';
import { useI18n } from '../i18n';
import { localizedWritingStyles } from '../i18n/writing-styles';
import { InlineContextEditor, type InlineContextEditorHandle } from './InlineContextEditor';
import { QuickSettingsControl } from './QuickSettingsControl';

export interface AnotherTextSubmission {
  readonly text: string;
  readonly inlineContexts: readonly string[];
  readonly writingStyleIds: readonly string[];
}

export function AnotherTextBar({
  settings,
  enterToSend,
  translationConfigured,
  busy,
  onSubmit,
  onImageFile,
  openSettings,
  openWritingStyles,
}: {
  readonly settings: SettingsSnapshot | null;
  readonly enterToSend: boolean;
  readonly translationConfigured: boolean;
  readonly busy: boolean;
  readonly onSubmit: (submission: AnotherTextSubmission) => Promise<boolean>;
  readonly onImageFile: (file: File) => void;
  readonly openSettings: () => void;
  readonly openWritingStyles: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement>(null);
  const stylePopoverRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<InlineContextEditorHandle>(null);
  const styleButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const styleCloseTimerRef = useRef<number | null>(null);
  const stylePickerId = useId();
  const [value, setValue] = useState({ text: '', inlineContexts: [] as readonly string[] });
  const [editorKey, setEditorKey] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [collapsedByEscape, setCollapsedByEscape] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [stylePickerRendered, setStylePickerRendered] = useState(false);
  const [selectedStyleIds, setSelectedStyleIds] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);
  const hasText = value.text.trim().length > 0;
  const hasContent = hasText || value.inlineContexts.length > 0;
  const styles = useMemo(
    () =>
      localizedWritingStyles(
        settings?.writingStyles.filter(
          (style) =>
            style.hidden !== true &&
            style.deleted !== true &&
            !FIXED_ADJUSTMENT_STYLE_IDS.includes(
              style.id as (typeof FIXED_ADJUSTMENT_STYLE_IDS)[number],
            ),
        ) ?? [],
        t,
      ),
    [settings?.writingStyles, t],
  );
  // Escape後は入力内容を残したまま閉じ、再フォーカスで編集を続けるときだけ再展開する。
  const opened = (expanded || hasContent) && !collapsedByEscape;

  const closeStylePicker = (): void => {
    if (styleCloseTimerRef.current !== null) window.clearTimeout(styleCloseTimerRef.current);
    setStylePickerOpen(false);
    styleCloseTimerRef.current = window.setTimeout(() => {
      setStylePickerRendered(false);
      styleCloseTimerRef.current = null;
    }, 140);
  };
  const showStylePicker = (): void => {
    if (styleCloseTimerRef.current !== null) {
      window.clearTimeout(styleCloseTimerRef.current);
      styleCloseTimerRef.current = null;
    }
    setStylePickerRendered(true);
    setStylePickerOpen(true);
  };

  useEffect(() => {
    if (!stylePickerRendered) return;
    const closeOutside = (event: MouseEvent): void => {
      if (!barRef.current?.contains(event.target as Node)) closeStylePicker();
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [stylePickerRendered]);

  useEffect(() => {
    if (!stylePickerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      stylePopoverRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [stylePickerOpen]);

  useEffect(
    () => () => {
      if (styleCloseTimerRef.current !== null) window.clearTimeout(styleCloseTimerRef.current);
    },
    [],
  );

  const submit = async (): Promise<void> => {
    if (sending || busy || !hasText || !translationConfigured) return;
    setSending(true);
    try {
      const started = await onSubmit({
        text: value.text,
        inlineContexts: value.inlineContexts,
        writingStyleIds: selectedStyleIds,
      });
      if (started) {
        setValue({ text: '', inlineContexts: [] });
        setEditorKey((current) => current + 1);
        setExpanded(false);
        closeStylePicker();
      }
    } catch {
      // 呼び出し側が通常の翻訳開始エラーを表示し、入力はそのまま残す。
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      ref={barRef}
      className={`nani-new-bar another-text-bar${opened ? ' expanded' : ''}`}
      onBlurCapture={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest('.inline-context-editor')) {
          return;
        }
        window.requestAnimationFrame(() => {
          if (!hasContent) setExpanded(false);
        });
      }}
    >
      <QuickSettingsControl settings={settings} openSettings={openSettings} placement="below" />
      <InlineContextEditor
        key={editorKey}
        ref={editorRef}
        label={t('main.textLabel')}
        placeholder={t('main.anotherText')}
        submitOnEnter={enterToSend}
        onEscape={() => {
          closeStylePicker();
          setCollapsedByEscape(true);
          setExpanded(false);
          editorRef.current?.blur();
        }}
        onFocus={() => {
          setCollapsedByEscape(false);
          setExpanded(true);
        }}
        onImageFile={onImageFile}
        onChange={setValue}
        onSubmit={() => void submit()}
      />
      <button
        ref={styleButtonRef}
        className={
          selectedStyleIds.length > 0
            ? 'another-text-style-button selected'
            : 'another-text-style-button'
        }
        type="button"
        aria-label={t('main.adjustStyle')}
        aria-haspopup="dialog"
        aria-controls={stylePickerRendered ? stylePickerId : undefined}
        aria-pressed={selectedStyleIds.length > 0}
        aria-expanded={stylePickerOpen}
        title={t('main.adjustStyle')}
        onClick={() => (stylePickerOpen ? closeStylePicker() : showStylePicker())}
      >
        <Sparkles size={19} aria-hidden="true" />
        {selectedStyleIds.length > 0 && (
          <span className="another-text-style-count" aria-hidden="true">
            {selectedStyleIds.length}
          </span>
        )}
      </button>
      {!hasText && (
        <button
          className="another-text-image-button"
          type="button"
          aria-label={t('main.imageTitle')}
          title={t('main.imageTitle')}
          onClick={() => imageInputRef.current?.click()}
        >
          <ImageIcon size={19} aria-hidden="true" />
        </button>
      )}
      {opened && (
        <div className="another-text-submit">
          <button
            className="translate-button"
            type="button"
            disabled={sending || busy || !hasText || !translationConfigured}
            aria-busy={sending}
            onClick={() => void submit()}
          >
            {t('main.translate')} <ArrowUp size={17} aria-hidden="true" />
          </button>
        </div>
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) onImageFile(file);
        }}
      />
      {stylePickerRendered && (
        <div
          ref={stylePopoverRef}
          id={stylePickerId}
          className={
            stylePickerOpen ? 'another-text-style-popover' : 'another-text-style-popover closing'
          }
          role="dialog"
          aria-label={t('main.adjustStyle')}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closeStylePicker();
            window.requestAnimationFrame(() => styleButtonRef.current?.focus());
          }}
        >
          <header className="another-text-style-header">
            <strong>{t('main.adjustStyle')}</strong>
            <div>
              {selectedStyleIds.length > 0 && (
                <button
                  className="another-text-style-clear"
                  type="button"
                  onClick={() => setSelectedStyleIds([])}
                >
                  <X size={13} aria-hidden="true" />
                  {t('main.clearStyleSelection')}
                </button>
              )}
              <button
                className="composer-style-settings"
                type="button"
                aria-label={t('main.manageStyles')}
                title={t('main.manageStyles')}
                onClick={() => {
                  closeStylePicker();
                  styleButtonRef.current?.focus();
                  openWritingStyles();
                }}
              >
                <SettingsIcon size={17} aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className="another-text-style-options">
            {styles.map((style: WritingStyle) => {
              const selected = selectedStyleIds.includes(style.id);
              return (
                <button
                  className={selected ? 'selected' : undefined}
                  type="button"
                  key={style.id}
                  aria-pressed={selected}
                  onClick={() =>
                    setSelectedStyleIds((current) =>
                      current.includes(style.id)
                        ? current.filter((id) => id !== style.id)
                        : [...current, style.id],
                    )
                  }
                >
                  <span aria-hidden="true">{style.icon ?? '✨'}</span>
                  {style.name}
                </button>
              );
            })}
            <button
              className="another-text-style-add"
              type="button"
              aria-label={t('main.addStyle')}
              title={t('main.addStyle')}
              onClick={() => {
                closeStylePicker();
                styleButtonRef.current?.focus();
                openWritingStyles();
              }}
            >
              <Plus size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
