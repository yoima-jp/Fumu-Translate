import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Image as ImageIcon,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from 'lucide-react';
import type { SettingsSnapshot, WritingStyle } from '../../../shared/settings-contracts';
import { FIXED_ADJUSTMENT_STYLE_IDS } from '../../../shared/settings-contracts';
import { useI18n } from '../i18n';
import { localizedWritingStyles } from '../i18n/writing-styles';
import { InlineContextEditor, type InlineContextEditorHandle } from './InlineContextEditor';

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
  openWritingStyles,
}: {
  readonly settings: SettingsSnapshot | null;
  readonly enterToSend: boolean;
  readonly translationConfigured: boolean;
  readonly busy: boolean;
  readonly onSubmit: (submission: AnotherTextSubmission) => Promise<boolean>;
  readonly onImageFile: (file: File) => void;
  readonly openWritingStyles: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<InlineContextEditorHandle>(null);
  const styleButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState({ text: '', inlineContexts: [] as readonly string[] });
  const [editorKey, setEditorKey] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [selectedStyleIds, setSelectedStyleIds] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);
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
  const opened =
    expanded || stylePickerOpen || value.text.length > 0 || value.inlineContexts.length > 0;

  useEffect(() => {
    if (!stylePickerOpen) return;
    const closeOutside = (event: MouseEvent): void => {
      if (!barRef.current?.contains(event.target as Node)) setStylePickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      setStylePickerOpen(false);
      window.requestAnimationFrame(() => styleButtonRef.current?.focus());
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [stylePickerOpen]);

  const submit = async (): Promise<void> => {
    if (sending || busy || value.text.trim().length === 0 || !translationConfigured) return;
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
        setStylePickerOpen(false);
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
      onFocusCapture={() => setExpanded(true)}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node && barRef.current?.contains(event.relatedTarget)) {
          return;
        }
        window.requestAnimationFrame(() => {
          if (value.text.trim().length === 0 && value.inlineContexts.length === 0) {
            setExpanded(false);
            setStylePickerOpen(false);
          }
        });
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key !== 'Escape') return;
        if (stylePickerOpen) {
          event.preventDefault();
          setStylePickerOpen(false);
          styleButtonRef.current?.focus();
        } else if (expanded) {
          event.preventDefault();
          setExpanded(false);
          editorRef.current?.blur();
        }
      }}
    >
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
        aria-pressed={selectedStyleIds.length > 0}
        aria-expanded={stylePickerOpen}
        title={t('main.adjustStyle')}
        onClick={() => setStylePickerOpen((current) => !current)}
      >
        <SlidersHorizontal size={19} aria-hidden="true" />
      </button>
      <InlineContextEditor
        key={editorKey}
        ref={editorRef}
        label={t('main.textLabel')}
        placeholder={t('main.anotherText')}
        submitOnEnter={enterToSend}
        onEscape={() => {
          if (stylePickerOpen) setStylePickerOpen(false);
          else setExpanded(false);
          editorRef.current?.blur();
        }}
        onImageFile={onImageFile}
        onChange={setValue}
        onSubmit={() => void submit()}
      />
      {value.text.trim().length === 0 ? (
        <button
          className="another-text-image-button"
          type="button"
          aria-label={t('main.imageTitle')}
          title={t('main.imageTitle')}
          onClick={() => imageInputRef.current?.click()}
        >
          <ImageIcon size={19} aria-hidden="true" />
        </button>
      ) : (
        <div className="another-text-submit">
          <button
            className="translate-button"
            type="button"
            disabled={sending || busy || !translationConfigured}
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
      {stylePickerOpen && (
        <div className="another-text-style-popover" role="dialog" aria-label={t('main.style')}>
          <div className="composer-style-picker">
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
              className="composer-style-settings"
              type="button"
              aria-label={t('main.manageStyles')}
              title={t('main.manageStyles')}
              onClick={() => {
                setStylePickerOpen(false);
                openWritingStyles();
              }}
            >
              <SettingsIcon size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
