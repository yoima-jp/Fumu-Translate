import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  DEFAULT_WRITING_STYLES,
  FIXED_ADJUSTMENT_STYLE_IDS,
  MAX_WRITING_STYLE_INSTRUCTION_LENGTH,
  MAX_WRITING_STYLE_NAME_LENGTH,
  NATIVE_LANGUAGE_OPTIONS,
  WRITING_STYLE_ICON_OPTIONS,
} from '../../../shared/settings-contracts';
import type {
  GeneralSettingsUpdate,
  SettingsSnapshot,
  WritingStyle,
} from '../../../shared/settings-contracts';
import { wrappedFocusIndex } from '../soft-select-navigation';
import { ProviderModelSettings } from './ProviderModelSettings';
import { useI18n } from '../i18n';
import { localizedWritingStyles } from '../i18n/writing-styles';
import { targetAfterNativeLanguageChange } from './language-target';
import { recordDeveloperModeTap } from './developer-mode-taps';
import { displayAccelerator } from './shortcut-display';
import desktopPackage from '../../../../package.json';
import type { UpdateStatus } from '../../../shared/update-contracts';
import thirdPartyNotices from '../../../../../../THIRD_PARTY_NOTICES.md?raw';

interface SoftSelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function SoftSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  fullWidth = false,
  selectedPrefix = '',
}: {
  readonly value: T;
  readonly options: readonly SoftSelectOption<T>[];
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly fullWidth?: boolean;
  readonly selectedPrefix?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 170 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeOnViewportChange = (event: Event): void => {
      // Listbox is portaled to body, so its own scroll also reaches this
      // capture listener. Keep it open while the user is browsing options;
      // only scrolling an ancestor/page should dismiss the menu.
      if (
        event.type === 'scroll' &&
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const openMenu = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const padding = 12;
    const width = Math.min(
      Math.max(rect.width, fullWidth ? rect.width : 170),
      window.innerWidth - padding * 2,
    );
    const menuHeight = Math.min(options.length * 42 + 12, 300);
    const below = rect.bottom + 7;
    const top =
      below + menuHeight <= window.innerHeight - padding
        ? below
        : Math.max(padding, rect.top - menuHeight - 7);
    const left = Math.min(
      window.innerWidth - width - padding,
      Math.max(padding, rect.right - width),
    );
    setPosition({ top, left, width });
    setOpen(true);
  };

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const dialog = triggerRef.current?.closest<HTMLElement>('[role="dialog"]');
      // The listbox is portaled to body. Exclude its options and move relative to
      // the trigger in either the modal focus trap or the surrounding document.
      const focusScope = dialog ?? document;
      const controls = Array.from(
        focusScope.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((control) => !menuRef.current?.contains(control));
      const targetIndex = wrappedFocusIndex(
        controls.indexOf(triggerRef.current as HTMLElement),
        controls.length,
        event.shiftKey,
      );
      setOpen(false);
      window.requestAnimationFrame(() => {
        if (targetIndex !== null) controls[targetIndex]?.focus();
      });
      return;
    }
    const nextIndex =
      event.key === 'ArrowDown'
        ? (current + 1) % items.length
        : event.key === 'ArrowUp'
          ? (current - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  return (
    <div className={fullWidth ? 'soft-select full-width' : 'soft-select'}>
      <button
        ref={triggerRef}
        className="soft-select-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          if (!open) openMenu();
        }}
      >
        <span>
          {selectedPrefix}
          {selected?.label ?? value}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            className="soft-select-menu"
            role="listbox"
            aria-label={label}
            style={position}
            onKeyDown={moveFocus}
          >
            {options.map((option) => {
              const optionSelected = option.value === value;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={optionSelected}
                  key={option.value}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <span>{option.label}</span>
                  {optionSelected && <Check size={16} aria-hidden="true" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'LeftBracket',
  ']': 'RightBracket',
  '\\': 'Backslash',
  '-': 'Minus',
  '=': 'Plus',
};

function acceleratorFromEvent(event: React.KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key) || event.key === 'Escape') {
    return null;
  }
  let key = KEY_ALIASES[event.key] ?? event.key;
  if (/^[a-z]$/u.test(key)) key = key.toUpperCase();
  if (
    !/^[A-Z0-9]$/u.test(key) &&
    !/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(key) &&
    !Object.values(KEY_ALIASES).includes(key)
  ) {
    const allowedNames = new Set([
      'Backspace',
      'Delete',
      'Insert',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Tab',
      'Enter',
      'Space',
      'Up',
      'Down',
      'Left',
      'Right',
      'Comma',
      'Period',
      'Slash',
      'Semicolon',
      'Quote',
      'LeftBracket',
      'RightBracket',
      'Backslash',
      'Minus',
      'Plus',
    ]);
    if (!allowedNames.has(key)) return null;
  }
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('CommandOrControl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  if (modifiers.length === 0 && !/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(key)) return null;
  return [...modifiers, key].join('+');
}

function ShortcutSettings({ settings }: { settings: SettingsSnapshot }) {
  const { t } = useI18n();
  const [shortcut, setShortcut] = useState(settings.shortcut);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const recorderRef = useRef<HTMLButtonElement>(null);
  const captureActiveRef = useRef(false);

  useEffect(() => setShortcut(settings.shortcut), [settings.shortcut]);
  useEffect(() => {
    if (recording) recorderRef.current?.focus();
  }, [recording]);
  useEffect(
    () => () => {
      if (captureActiveRef.current) {
        captureActiveRef.current = false;
        void window.fumu.endShortcutCapture();
      }
    },
    [],
  );

  const stopRecording = (): void => {
    setRecording(false);
    if (!captureActiveRef.current) return;
    captureActiveRef.current = false;
    void window.fumu.endShortcutCapture().catch(() => setMessage(t('common.settingsSaveError')));
  };

  const startRecording = (): void => {
    if (captureActiveRef.current) return;
    captureActiveRef.current = true;
    setMessage(t('settings.shortcutPrompt'));
    void window.fumu
      .beginShortcutCapture()
      .then(() => {
        if (captureActiveRef.current) setRecording(true);
      })
      .catch(() => {
        captureActiveRef.current = false;
        setRecording(false);
        setMessage(t('common.settingsSaveError'));
      });
  };

  const save = (value: string): void => {
    void window.fumu
      .updateShortcut(value)
      .then((result) => {
        setMessage(
          result.state === 'disabled' ? t('settings.shortcutDisabled') : t('settings.saved'),
        );
        if (result.state === 'registered' || result.state === 'disabled')
          setShortcut(result.shortcut);
      })
      .catch(() => setMessage(t('common.settingsSaveError')));
  };

  const saveCompactTranslation = (enabled: boolean): void => {
    void window.fumu
      .updateGeneralSettings({ compactTranslation: enabled })
      .then(() => setMessage(null))
      .catch(() => setMessage(t('common.settingsSaveError')));
  };

  return (
    <section className="settings-section nani-settings-card shortcut-settings">
      <div className="settings-heading-row">
        <h2>{t('settings.shortcut')}</h2>
      </div>
      <div className="shortcut-editor">
        <KeyRound size={18} aria-hidden="true" />
        <button
          ref={recorderRef}
          className={recording ? 'shortcut-recorder recording' : 'shortcut-recorder'}
          type="button"
          aria-label={t('settings.shortcutRecord')}
          onClick={startRecording}
          onBlur={stopRecording}
          onKeyDown={(event) => {
            if (!recording) return;
            event.preventDefault();
            event.stopPropagation();
            const value = acceleratorFromEvent(event);
            if (value === null) {
              setMessage(t('settings.shortcutInvalid'));
              return;
            }
            stopRecording();
            setShortcut(value);
            save(value);
          }}
        >
          {recording
            ? t('settings.shortcutPrompt')
            : displayAccelerator(shortcut, t('common.notConfigured'))}
        </button>
        <button className="text-button" type="button" onClick={() => save('')}>
          {t('settings.disable')}
        </button>
      </div>
      <label className="settings-line settings-toggle compact-translation-setting">
        <span>
          <strong>{t('settings.compactTranslation')}</strong>
          <small>{t('settings.compactTranslationDetail')}</small>
        </span>
        <input
          type="checkbox"
          checked={settings.compactTranslation}
          aria-label={t('settings.compactTranslation')}
          onChange={(event) => saveCompactTranslation(event.currentTarget.checked)}
        />
        <span className="quick-settings-switch" aria-hidden="true" />
      </label>
      {message && (
        <p className="field-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function GeneralSettings({
  settings,
  onManageWritingStyles,
}: {
  readonly settings: SettingsSnapshot;
  readonly onManageWritingStyles: () => void;
}) {
  const { t, formatLanguageName } = useI18n();
  const targetLanguageOptions = useMemo(
    () =>
      NATIVE_LANGUAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: formatLanguageName(option.value),
      })),
    [formatLanguageName],
  );
  const [error, setError] = useState<string | null>(null);
  const update = (patch: GeneralSettingsUpdate): void => {
    void window.fumu
      .updateGeneralSettings(patch)
      .then(() => setError(null))
      .catch(() => setError(t('common.settingsSaveError')));
  };
  return (
    <section className="settings-section nani-settings-card">
      <div className="settings-line">
        <span>
          <strong>{t('settings.appearance')}</strong>
          <small>{t('settings.appearanceDetail')}</small>
        </span>
        <SoftSelect
          label={t('settings.appearance')}
          value={settings.appearance}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'light', label: t('settings.themeLight') },
            { value: 'dark', label: t('settings.themeDark') },
          ]}
          onChange={(appearance) => update({ appearance })}
        />
      </div>
      <div className="settings-line">
        <span>
          <strong>{t('settings.language')}</strong>
          <small>{t('settings.languageDetail')}</small>
        </span>
        <SoftSelect
          label={t('settings.language')}
          value={settings.nativeLanguage ?? 'English'}
          options={NATIVE_LANGUAGE_OPTIONS}
          onChange={(nativeLanguage) =>
            update({
              nativeLanguage,
              otherLanguageTarget: targetAfterNativeLanguageChange(
                nativeLanguage,
                settings.otherLanguageTarget,
              ),
            })
          }
        />
      </div>
      <div className="settings-line">
        <span>
          <strong>{t('settings.otherLanguageTarget')}</strong>
          <small>{t('settings.otherLanguageTargetDetail')}</small>
        </span>
        <SoftSelect
          label={t('settings.otherLanguageTarget')}
          value={settings.otherLanguageTarget}
          options={targetLanguageOptions}
          onChange={(otherLanguageTarget) =>
            update({
              otherLanguageTarget: targetAfterNativeLanguageChange(
                settings.nativeLanguage,
                otherLanguageTarget,
              ),
            })
          }
        />
      </div>
      <div className="settings-line">
        <span>
          <strong>{t('settings.historyRetention')}</strong>
          <small>{t('settings.historyRetentionDetail')}</small>
        </span>
        <SoftSelect<string>
          label={t('settings.historyRetention')}
          value={
            settings.historyEnabled ? String(settings.historyRetentionDays ?? 'forever') : 'off'
          }
          options={[
            { value: '30', label: t('settings.days', { count: 30 }) },
            { value: '90', label: t('settings.days', { count: 90 }) },
            { value: '180', label: t('settings.days', { count: 180 }) },
            { value: '365', label: t('settings.days', { count: 365 }) },
            { value: 'forever', label: t('settings.forever') },
            { value: 'off', label: t('settings.doNotSave') },
          ]}
          onChange={(retention) => {
            update(
              retention === 'off'
                ? { historyEnabled: false }
                : {
                    historyEnabled: true,
                    historyRetentionDays:
                      retention === 'forever'
                        ? null
                        : (Number(retention) as SettingsSnapshot['historyRetentionDays']),
                  },
            );
          }}
        />
      </div>
      <label
        className={
          settings.startupSupported
            ? 'settings-line settings-toggle'
            : 'settings-line settings-toggle disabled'
        }
      >
        <span>
          <strong>{t('settings.autoStart')}</strong>
          <small>
            {settings.startupSupported
              ? t('settings.autoStartAvailable')
              : t('settings.autoStartUnavailable')}
          </small>
        </span>
        <input
          type="checkbox"
          checked={settings.launchAtLogin}
          disabled={!settings.startupSupported}
          aria-label={t('settings.autoStart')}
          onChange={(event) => update({ launchAtLogin: event.currentTarget.checked })}
        />
        <span className="quick-settings-switch" aria-hidden="true" />
      </label>
      {settings.developerMode && (
        <label className="settings-line settings-toggle">
          <span>
            <strong>{t('settings.debugMode')}</strong>
            <small>{t('settings.debugModeDetail')}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.debugMode}
            aria-label={t('settings.debugMode')}
            onChange={(event) => update({ debugMode: event.currentTarget.checked })}
          />
          <span className="quick-settings-switch" aria-hidden="true" />
        </label>
      )}
      <div className="settings-line">
        <span>
          <strong>{t('settings.styles')}</strong>
          <small>{t('settings.stylesDetail')}</small>
        </span>
        <button className="settings-manage-button" type="button" onClick={onManageWritingStyles}>
          {t('common.manage')}
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <p className="main-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function UpdateSettings(): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<'opened' | 'error' | null>(null);
  const check = async (): Promise<void> => {
    setBusy(true);
    setDownloadMessage(null);
    try {
      setStatus(await window.fumu.checkUpdates());
    } catch {
      setStatus({ phase: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const download = async (): Promise<void> => {
    setBusy(true);
    try {
      setDownloadMessage((await window.fumu.downloadUpdate()) ? 'opened' : 'error');
    } catch {
      setDownloadMessage('error');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void check();
  }, []);
  return (
    <section className="settings-section nani-settings-card">
      <div className="settings-line">
        <span>
          <strong>{t('updates.title')}</strong>
          <small role="status" aria-live="polite">
            {busy
              ? t(status?.phase === 'available' ? 'updates.installing' : 'updates.busy')
              : status?.phase === 'available'
                ? t('updates.available', { version: status.version })
                : status
                  ? t(`updates.${status.phase}`)
                  : ''}
          </small>
        </span>
        <button
          className="settings-manage-button"
          type="button"
          disabled={busy}
          onClick={() => void (status?.phase === 'available' ? download() : check())}
        >
          {t(status?.phase === 'available' ? 'updates.download' : 'updates.check')}
        </button>
      </div>
      {status?.phase === 'available' && (
        <p>{t(status.portable ? 'updates.portableInstall' : 'updates.installHint')}</p>
      )}
      {downloadMessage && (
        <p role="status">
          {t(downloadMessage === 'error' ? 'updates.downloadError' : 'updates.opened')}
        </p>
      )}
    </section>
  );
}

function SettingsFooter({
  settings,
  onOpenThirdPartyNotices,
  thirdPartyNoticesTriggerRef,
}: {
  readonly settings: SettingsSnapshot;
  readonly onOpenThirdPartyNotices: () => void;
  readonly thirdPartyNoticesTriggerRef: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const { t } = useI18n();
  const tapsRef = useRef<readonly number[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const tapVersion = (): void => {
    if (settings.developerMode) return;
    const result = recordDeveloperModeTap(tapsRef.current, Date.now());
    tapsRef.current = result.recentTaps;
    if (!result.unlocked) return;

    // 解放状態は再起動後も維持し、デバッグ設定が意図せず再び隠れないようにする。
    tapsRef.current = [];
    void window.fumu
      .updateGeneralSettings({ developerMode: true })
      .then(() => setMessage(t('settings.developerModeEnabled')))
      .catch(() => setMessage(t('common.settingsSaveError')));
  };

  return (
    <footer className="settings-footer">
      <div className="settings-footer-links">
        <button type="button" onClick={tapVersion} aria-label={t('settings.version')}>
          {t('settings.versionValue', { version: desktopPackage.version })}
        </button>
        <span aria-hidden="true">・</span>
        <button ref={thirdPartyNoticesTriggerRef} type="button" onClick={onOpenThirdPartyNotices}>
          {t('settings.thirdPartyNotices')}
        </button>
      </div>
      {message && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
    </footer>
  );
}

function ThirdPartyNotices(): React.JSX.Element {
  return (
    <article className="third-party-notices">
      <pre>{thirdPartyNotices}</pre>
    </article>
  );
}

function WritingStyleSettings({
  settings,
  showTitle = true,
  backRequest = 0,
  onEditingChange,
}: {
  readonly settings: SettingsSnapshot;
  readonly showTitle?: boolean;
  readonly backRequest?: number;
  readonly onEditingChange?: (editing: boolean) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<WritingStyle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuStyleId, setMenuStyleId] = useState<string | null>(null);
  const styleListRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    onEditingChange?.(editing !== null);
  }, [editing, onEditingChange]);
  useEffect(() => {
    if (backRequest === 0) return;
    setEditing(null);
    setMenuStyleId(null);
  }, [backRequest]);
  useEffect(() => {
    if (editing === null) return;
    // 行クリックでフォームへ切り替えると、長い一覧の現在位置が残る。
    // 編集フォームの見出しを必ず視界へ戻し、下段項目でも迷子にしない。
    sectionRef.current?.closest<HTMLElement>('.settings-subview')?.scrollTo({ top: 0 });
  }, [editing]);
  useEffect(() => {
    if (menuStyleId === null) return;
    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !styleListRef.current?.contains(event.target)) {
        setMenuStyleId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuStyleId(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuStyleId]);

  const persist = (styles: readonly WritingStyle[]): void => {
    void window.fumu
      .updateGeneralSettings({
        writingStyles: styles,
        // 文体は調整時だけ適用し、通常翻訳は常に標準にする。
        activeWritingStyleId: null,
      })
      .then(() => {
        setEditing(null);
        setError(null);
      })
      .catch(() => setError(t('common.settingsSaveError')));
  };
  const displayedStyles = localizedWritingStyles(settings.writingStyles, t);
  return (
    <section ref={sectionRef} className="settings-section nani-settings-card">
      <div className="settings-heading-row">
        {showTitle && <h2>{t('settings.styles')}</h2>}
        {editing === null && (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setMenuStyleId(null);
              setEditing({ id: crypto.randomUUID(), name: '', instruction: '', icon: '✨' });
            }}
          >
            <Plus size={15} />
            {t('settings.styleAdd')}
          </button>
        )}
      </div>
      {editing === null ? (
        <div className="style-list" ref={styleListRef}>
          {displayedStyles
            .filter(
              (style) =>
                style.deleted !== true &&
                !FIXED_ADJUSTMENT_STYLE_IDS.includes(
                  style.id as (typeof FIXED_ADJUSTMENT_STYLE_IDS)[number],
                ),
            )
            .map((style) => (
              <div
                className={style.hidden === true ? 'style-row hidden' : 'style-row'}
                key={style.id}
              >
                <button
                  type="button"
                  onClick={() => {
                    setMenuStyleId(null);
                    setEditing(style);
                  }}
                >
                  <span>
                    <strong>
                      <span className="style-icon" aria-hidden="true">
                        {style.icon ?? '✨'}
                      </span>
                      {style.name}
                    </strong>
                    <small>{style.description ?? style.instruction}</small>
                  </span>
                </button>
                <button
                  className="icon-button style-menu-trigger"
                  type="button"
                  aria-label={t('settings.styleMenu', { name: style.name })}
                  aria-expanded={menuStyleId === style.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuStyleId((current) => (current === style.id ? null : style.id));
                  }}
                >
                  <MoreHorizontal size={17} />
                </button>
                {menuStyleId === style.id && (
                  <div className="style-context-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        persist(
                          settings.writingStyles.map((candidate) =>
                            candidate.id === style.id
                              ? { ...candidate, hidden: style.hidden !== true }
                              : candidate,
                          ),
                        );
                        setMenuStyleId(null);
                      }}
                    >
                      {style.hidden === true ? <Eye size={15} /> : <EyeOff size={15} />}
                      {style.hidden === true ? t('settings.styleShow') : t('settings.styleHide')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuStyleId(null);
                        setEditing({
                          ...style,
                          id: crypto.randomUUID(),
                          name: t('settings.styleCopyName', { name: style.name }),
                          hidden: false,
                        });
                      }}
                    >
                      <Copy size={15} />
                      {t('settings.styleDuplicate')}
                    </button>
                    <button
                      className="danger"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        const isDefault = DEFAULT_WRITING_STYLES.some(
                          (defaultStyle) => defaultStyle.id === style.id,
                        );
                        persist(
                          isDefault
                            ? settings.writingStyles.map((candidate) =>
                                candidate.id === style.id
                                  ? { ...candidate, deleted: true }
                                  : candidate,
                              )
                            : settings.writingStyles.filter(
                                (candidate) => candidate.id !== style.id,
                              ),
                        );
                        setMenuStyleId(null);
                      }}
                    >
                      <Trash2 size={15} />
                      {t('common.delete')}
                    </button>
                  </div>
                )}
              </div>
            ))}
        </div>
      ) : (
        <form
          className="style-editor"
          onSubmit={(event) => {
            event.preventDefault();
            const next = [
              ...settings.writingStyles.filter((style) => style.id !== editing.id),
              { ...editing, hidden: false },
            ];
            persist(next);
          }}
        >
          <label>
            <span>{t('settings.styleName')}</span>
            <input
              required
              maxLength={MAX_WRITING_STYLE_NAME_LENGTH}
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>{t('settings.styleEmoji')}</span>
            <div
              className="style-icon-picker"
              role="group"
              aria-label={t('settings.styleEmojiAria')}
            >
              {WRITING_STYLE_ICON_OPTIONS.map((icon) => (
                <button
                  className={(editing.icon ?? '✨') === icon ? 'selected' : undefined}
                  type="button"
                  aria-label={icon}
                  aria-pressed={(editing.icon ?? '✨') === icon}
                  key={icon}
                  onClick={() => setEditing({ ...editing, icon })}
                >
                  {icon}
                </button>
              ))}
            </div>
          </label>
          <label>
            <span>{t('settings.styleInstruction')}</span>
            <textarea
              required
              maxLength={MAX_WRITING_STYLE_INSTRUCTION_LENGTH}
              rows={3}
              value={editing.instruction}
              placeholder={t('settings.styleInstructionPlaceholder')}
              onChange={(event) =>
                setEditing({ ...editing, instruction: event.currentTarget.value })
              }
            />
          </label>
          <div className="form-actions">
            {settings.writingStyles.some((style) => style.id === editing.id) &&
              !DEFAULT_WRITING_STYLES.some((style) => style.id === editing.id) && (
                <button
                  className="text-button danger"
                  type="button"
                  onClick={() =>
                    persist(settings.writingStyles.filter((style) => style.id !== editing.id))
                  }
                >
                  {t('common.delete')}
                </button>
              )}
            <span />
            <button className="text-button" type="button" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
            <button className="primary-button no-margin" type="submit">
              {t('common.save')}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="main-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function SettingsView({
  settings,
  close,
  openWritingStylesOnMount = false,
}: {
  settings: SettingsSnapshot;
  close?: () => void;
  openWritingStylesOnMount?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [writingStylesOpen, setWritingStylesOpen] = useState(openWritingStylesOnMount);
  const [writingStylesRendered, setWritingStylesRendered] = useState(openWritingStylesOnMount);
  const [providerModelsOpen, setProviderModelsOpen] = useState(false);
  const [thirdPartyNoticesOpen, setThirdPartyNoticesOpen] = useState(false);
  const [writingStyleEditing, setWritingStyleEditing] = useState(false);
  const [writingStyleBackRequest, setWritingStyleBackRequest] = useState(0);
  const writingStylesCloseTimerRef = useRef<number | null>(null);
  const writingStylesRef = useRef<HTMLElement>(null);
  const providerModelsRef = useRef<HTMLElement>(null);
  const providerModelsTriggerRef = useRef<HTMLButtonElement>(null);
  const thirdPartyNoticesRef = useRef<HTMLElement>(null);
  const thirdPartyNoticesTriggerRef = useRef<HTMLButtonElement>(null);
  const closeProviderModels = (): void => {
    setProviderModelsOpen(false);
    window.requestAnimationFrame(() => providerModelsTriggerRef.current?.focus());
  };
  const closeThirdPartyNotices = (): void => {
    setThirdPartyNoticesOpen(false);
    window.requestAnimationFrame(() => thirdPartyNoticesTriggerRef.current?.focus());
  };
  const openWritingStyles = (): void => {
    if (writingStylesCloseTimerRef.current !== null) {
      window.clearTimeout(writingStylesCloseTimerRef.current);
      writingStylesCloseTimerRef.current = null;
    }
    setWritingStylesRendered(true);
    setWritingStylesOpen(true);
  };
  const closeWritingStyles = (): void => {
    if (writingStylesCloseTimerRef.current !== null) {
      window.clearTimeout(writingStylesCloseTimerRef.current);
    }
    setWritingStylesOpen(false);
    writingStylesCloseTimerRef.current = window.setTimeout(() => {
      setWritingStylesRendered(false);
      writingStylesCloseTimerRef.current = null;
    }, 180);
  };
  useEffect(
    () => () => {
      if (writingStylesCloseTimerRef.current !== null) {
        window.clearTimeout(writingStylesCloseTimerRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    if (!writingStylesRendered) return;
    const frame = window.requestAnimationFrame(() => {
      writingStylesRef.current
        ?.querySelector<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
        )
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [writingStylesRendered]);
  useEffect(() => {
    if (!providerModelsOpen) return;
    const frame = window.requestAnimationFrame(() => {
      providerModelsRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [providerModelsOpen]);
  useEffect(() => {
    if (!thirdPartyNoticesOpen) return;
    const frame = window.requestAnimationFrame(() => {
      thirdPartyNoticesRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [thirdPartyNoticesOpen]);

  const subviewOpen = writingStylesRendered || providerModelsOpen || thirdPartyNoticesOpen;

  return (
    <div className={subviewOpen ? 'settings-page writing-styles-active' : 'settings-page'}>
      <div inert={subviewOpen}>
        <header className="page-title-row">
          <div>
            <span className="settings-eyebrow">{t('common.settings')}</span>
            <h1>{t('settings.general')}</h1>
          </div>
          {close && (
            <button
              className="settings-close icon-button"
              type="button"
              aria-label={t('common.close')}
              onClick={close}
            >
              <X size={21} />
            </button>
          )}
        </header>
        <GeneralSettings settings={settings} onManageWritingStyles={openWritingStyles} />
        <ShortcutSettings settings={settings} />
        <section className="settings-section nani-settings-card">
          <div className="settings-line">
            <span>
              <strong>{t('settings.model')}</strong>
              <small>
                {settings.usedModels.length === 0
                  ? t('common.notConfigured')
                  : t('settings.modelsUsed', { count: settings.usedModels.length })}
              </small>
            </span>
            <button
              ref={providerModelsTriggerRef}
              className="settings-manage-button"
              type="button"
              onClick={() => setProviderModelsOpen(true)}
            >
              {t('common.manage')}
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        </section>
        <UpdateSettings />
        <SettingsFooter
          settings={settings}
          onOpenThirdPartyNotices={() => setThirdPartyNoticesOpen(true)}
          thirdPartyNoticesTriggerRef={thirdPartyNoticesTriggerRef}
        />
      </div>
      {writingStylesRendered && (
        <section
          ref={writingStylesRef}
          className={
            writingStylesOpen ? 'settings-subview' : 'settings-subview settings-subview-closing'
          }
          role="dialog"
          aria-label={t('settings.styles')}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (writingStyleEditing) {
              setWritingStyleBackRequest((value) => value + 1);
            } else {
              closeWritingStyles();
            }
          }}
        >
          <header className="settings-subview-header">
            <button
              className="settings-subview-back icon-button"
              type="button"
              aria-label={
                writingStyleEditing ? t('settings.backToStyles') : t('settings.backToGeneral')
              }
              onClick={() => {
                if (writingStyleEditing) {
                  setWritingStyleBackRequest((value) => value + 1);
                } else {
                  closeWritingStyles();
                }
              }}
            >
              <ChevronLeft size={20} />
            </button>
            <div>
              <span className="settings-eyebrow">{t('common.settings')}</span>
              <h1>{t('settings.styles')}</h1>
            </div>
            {close && (
              <button
                className="settings-subview-close icon-button"
                type="button"
                aria-label={t('settings.closeSettings')}
                onClick={close}
              >
                <X size={20} />
              </button>
            )}
          </header>
          <WritingStyleSettings
            settings={settings}
            showTitle={false}
            backRequest={writingStyleBackRequest}
            onEditingChange={setWritingStyleEditing}
          />
        </section>
      )}
      {providerModelsOpen && (
        <ProviderModelSettings
          settings={settings}
          close={close ?? (() => setProviderModelsOpen(false))}
          back={closeProviderModels}
          rootRef={providerModelsRef}
        />
      )}
      {thirdPartyNoticesOpen && (
        <section
          ref={thirdPartyNoticesRef}
          className="settings-subview"
          role="dialog"
          aria-label={t('settings.thirdPartyNotices')}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closeThirdPartyNotices();
          }}
        >
          <header className="settings-subview-header">
            <button
              className="settings-subview-back icon-button"
              type="button"
              aria-label={t('settings.backToGeneral')}
              onClick={closeThirdPartyNotices}
            >
              <ChevronLeft size={20} />
            </button>
            <div>
              <span className="settings-eyebrow">{t('common.settings')}</span>
              <h1>{t('settings.thirdPartyNotices')}</h1>
            </div>
            {close && (
              <button
                className="settings-subview-close icon-button"
                type="button"
                aria-label={t('settings.closeSettings')}
                onClick={close}
              >
                <X size={20} />
              </button>
            )}
          </header>
          <ThirdPartyNotices />
        </section>
      )}
    </div>
  );
}
