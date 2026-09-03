import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_UI_LOCALE,
  resolveEnvironmentUiLocale,
  resolveUiLocale,
  UI_LOCALE_METADATA,
  type UiLocale,
} from '@fumu/i18n';
import { NATIVE_LANGUAGE_OPTIONS } from '../../../shared/settings-contracts';
import { catalogs, type MessageKey } from './catalog';

type MessageValues = Readonly<Record<string, string | number>>;

export function translateMessage(
  locale: UiLocale,
  key: MessageKey,
  values: MessageValues = {},
): string {
  const template = catalogs[locale]?.[key] ?? catalogs[DEFAULT_UI_LOCALE][key];
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

interface I18nValue {
  readonly locale: UiLocale;
  readonly t: (key: MessageKey, values?: MessageValues) => string;
  readonly formatDateTime: (value: number) => string;
  readonly formatLanguageName: (value: string) => string;
}

export function displayLanguageName(locale: UiLocale, value: string): string {
  const code = NATIVE_LANGUAGE_OPTIONS.find((option) => option.value === value)?.tag ?? value;
  try {
    return (
      new Intl.DisplayNames([UI_LOCALE_METADATA[locale].tag], { type: 'language' }).of(code) ??
      value
    );
  } catch {
    // Providers may return free-form language names. Preserve those values rather than
    // replacing useful result metadata with a generic label.
    return value;
  }
}

const defaultValue: I18nValue = {
  locale: DEFAULT_UI_LOCALE,
  t: (key, values) => translateMessage(DEFAULT_UI_LOCALE, key, values),
  formatDateTime: (value) => new Intl.DateTimeFormat('en', dateTimeOptions).format(new Date(value)),
  formatLanguageName: (value) => displayLanguageName(DEFAULT_UI_LOCALE, value),
};

const I18nContext = createContext<I18nValue>(defaultValue);

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

export function I18nProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  // 初回起動ではまだ「あなたの言語」が保存されていない。設定取得を待つ間も
  // 日本語環境だけは日本語を表示し、それ以外は対応範囲が明確な英語へ寄せる。
  const environmentLocale = resolveEnvironmentUiLocale(navigator.languages);
  const [locale, setLocale] = useState<UiLocale>(environmentLocale);

  useEffect(() => {
    let active = true;
    const applyNativeLanguage = (nativeLanguage: unknown): void => {
      if (!active) return;
      const nextLocale =
        nativeLanguage === null || nativeLanguage === undefined
          ? environmentLocale
          : resolveUiLocale(nativeLanguage);
      setLocale(nextLocale);
      document.documentElement.lang = UI_LOCALE_METADATA[nextLocale].tag;
    };

    void window.fumu
      .getSettings()
      .then((settings) => applyNativeLanguage(settings.nativeLanguage))
      .catch(() => applyNativeLanguage(undefined));
    const unsubscribe = window.fumu.onSettingsChanged((settings) => {
      applyNativeLanguage(settings.nativeLanguage);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [environmentLocale]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      t: (key, values) => translateMessage(locale, key, values),
      formatDateTime: (input) =>
        new Intl.DateTimeFormat(UI_LOCALE_METADATA[locale].tag, dateTimeOptions).format(
          new Date(input),
        ),
      formatLanguageName: (input) => displayLanguageName(locale, input),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export type { MessageKey } from './catalog';
