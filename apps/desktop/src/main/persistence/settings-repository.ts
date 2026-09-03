import {
  APPEARANCE_VALUES,
  DEFAULT_TRANSLATE_SHORTCUT,
  DEFAULT_WRITING_STYLES,
  distinctTranslationTarget,
  HISTORY_RETENTION_DAY_VALUES,
  MAX_WRITING_STYLE_DESCRIPTION_LENGTH,
  MAX_WRITING_STYLE_INSTRUCTION_LENGTH,
  MAX_WRITING_STYLE_NAME_LENGTH,
  MAX_WRITING_STYLES,
  NATIVE_LANGUAGE_VALUES,
  OTHER_LANGUAGE_TARGET_VALUES,
  TRANSLATION_STYLE_VALUES,
  type Appearance,
  type HistoryRetentionDays,
  type NativeLanguage,
  type OtherLanguageTarget,
  type TranslationStyle,
  type ProviderConnection,
  type ProviderConnectionDefinition,
  type UsedModelReference,
  type WritingStyle,
} from '../../shared/settings-contracts';
import {
  storedProviderConnectionSchema,
  usedModelReferenceSchema,
} from '../settings/profile-schema';
import type { FumuDatabase } from './database';

// 既存ユーザーの保存済みJSONに残る旧出荷値を識別する。ユーザーが組み込み
// 文体を編集していた場合は、意図した変更を上書きせず、そのまま保持する。
const LEGACY_WRITING_STYLE_VALUES: Readonly<Record<string, { name: string; instruction: string }>> =
  {
    '00000000-0000-4000-8000-000000000103': {
      name: '淡々と',
      instruction: '落ち着いた、簡潔で事実に忠実な表現にします。',
    },
    '00000000-0000-4000-8000-000000000104': {
      name: 'キャッチーに',
      instruction: '元の意味を保ちながら、印象に残る表現にします。',
    },
    '00000000-0000-4000-8000-000000000105': {
      name: 'カジュアルに',
      instruction: '友達と話すような自然でカジュアルな表現にします。',
    },
    '00000000-0000-4000-8000-000000000106': {
      name: 'ていねいに',
      instruction: '自然で丁寧な表現にします。',
    },
    '00000000-0000-4000-8000-000000000107': {
      name: 'ネイティブらしく自然に',
      instruction: 'その場面のネイティブが自然に使う表現にします。',
    },
    '00000000-0000-4000-8000-000000000108': {
      name: 'AIっぽさを消して',
      instruction: '定型的なAIらしい言い回しを避け、人が書いたような表現にします。',
    },
  };

// 保存済み設定に残る廃止済みプリセットを除外し、ユーザーの一覧や
// 調整メニューへ復活させないため、このIDは互換性境界として保持する。
const REMOVED_WRITING_STYLE_IDS = new Set(['00000000-0000-4000-8000-000000000109']);

interface SettingRow {
  readonly value: string;
}

interface ProfileRow {
  readonly id: string;
  readonly config_json: string;
  readonly encrypted_secret: Uint8Array | null;
}

export interface StoredProviderConnection {
  readonly provider: ProviderConnection;
  readonly encryptedSecret: Buffer | null;
}

export type EncryptedSecretUpdate =
  | { readonly action: 'preserve' }
  | { readonly action: 'clear' }
  | { readonly action: 'replace'; readonly value: Buffer };

export class SettingsRepository {
  readonly #database: FumuDatabase;

  constructor(database: FumuDatabase) {
    this.#database = database;
  }

  get shortcut(): string {
    return this.#getSetting('shortcut') ?? DEFAULT_TRANSLATE_SHORTCUT;
  }

  get historyEnabled(): boolean {
    return this.#getSetting('history_enabled') !== 'false';
  }

  get launchAtLogin(): boolean {
    return this.#getSetting('launch_at_login') === 'true';
  }

  get enterToSend(): boolean {
    return this.#getSetting('enter_to_send') === 'true';
  }

  get compactTranslation(): boolean {
    return this.#getSetting('compact_translation') !== 'false';
  }

  get developerMode(): boolean {
    return this.#getSetting('developer_mode') === 'true';
  }

  get debugMode(): boolean {
    return this.#getSetting('debug_mode') === 'true';
  }

  get translationStyle(): TranslationStyle {
    const value = this.#getSetting('translation_style');
    return value !== null && TRANSLATION_STYLE_VALUES.includes(value as TranslationStyle)
      ? (value as TranslationStyle)
      : 'natural';
  }

  get nativeLanguage(): NativeLanguage | null {
    const value = this.#getSetting('native_language');
    return value !== null && NATIVE_LANGUAGE_VALUES.includes(value as NativeLanguage)
      ? (value as NativeLanguage)
      : null;
  }

  get onboardingCompleted(): boolean {
    const value = this.#getSetting('onboarding_completed');
    if (value !== null) return value === 'true';

    // このフラグ導入前から利用しているユーザーには初回画面を再表示しない。
    // 新規ユーザーが途中終了した場合は開始時に false を明示保存するため、
    // 言語などの途中設定が既存利用データと誤判定されることはない。
    const row = this.#database.connection
      .prepare(
        `SELECT
           EXISTS(SELECT 1 FROM app_settings) OR
           EXISTS(SELECT 1 FROM providers) OR
           EXISTS(SELECT 1 FROM translation_sessions) AS has_existing_data`,
      )
      .get() as { readonly has_existing_data: number } | undefined;
    return row?.has_existing_data === 1;
  }

  get appearance(): Appearance {
    const value = this.#getSetting('appearance');
    return value !== null && APPEARANCE_VALUES.includes(value as Appearance)
      ? (value as Appearance)
      : 'system';
  }

  get otherLanguageTarget(): OtherLanguageTarget {
    const value = this.#getSetting('other_language_target');
    if (value !== null && OTHER_LANGUAGE_TARGET_VALUES.includes(value as OtherLanguageTarget)) {
      return distinctTranslationTarget(this.nativeLanguage, value as OtherLanguageTarget);
    }
    if (value === 'native') {
      // 旧版の疑似値は母国語と同じ値を表すため、そのまま復元すると常に無翻訳になる。
      // 現行ルールの既定対訳へ移し、既存ユーザーも同一言語翻訳から回復させる。
      const nativeLanguage = this.nativeLanguage;
      return nativeLanguage === null
        ? 'Japanese'
        : distinctTranslationTarget(nativeLanguage, nativeLanguage);
    }
    // 初回起動時は英語UIなので日本語を、非英語話者には英語を既定にする。
    return this.nativeLanguage === null || this.nativeLanguage === 'English'
      ? 'Japanese'
      : 'English';
  }

  get historyRetentionDays(): HistoryRetentionDays {
    const value = this.#getSetting('history_retention_days');
    if (value === 'forever') return null;
    const numeric = Number(value ?? '180');
    return HISTORY_RETENTION_DAY_VALUES.includes(numeric as 30 | 90 | 180 | 365)
      ? (numeric as 30 | 90 | 180 | 365)
      : 180;
  }

  get writingStyles(): readonly WritingStyle[] {
    const value = this.#getSetting('writing_styles');
    if (value === null) return DEFAULT_WRITING_STYLES;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return DEFAULT_WRITING_STYLES;
      const customStyles = parsed
        .slice(0, MAX_WRITING_STYLES)
        .filter((style): style is WritingStyle => {
          if (typeof style !== 'object' || style === null) return false;
          const candidate = style as WritingStyle;
          return (
            typeof candidate.id === 'string' &&
            candidate.id.length <= 64 &&
            typeof candidate.name === 'string' &&
            candidate.name.trim().length > 0 &&
            candidate.name.length <= MAX_WRITING_STYLE_NAME_LENGTH &&
            (candidate.description === undefined ||
              (typeof candidate.description === 'string' &&
                candidate.description.length <= MAX_WRITING_STYLE_DESCRIPTION_LENGTH)) &&
            typeof candidate.instruction === 'string' &&
            candidate.instruction.trim().length > 0 &&
            candidate.instruction.length <= MAX_WRITING_STYLE_INSTRUCTION_LENGTH &&
            (candidate.hidden === undefined || typeof candidate.hidden === 'boolean') &&
            (candidate.deleted === undefined || typeof candidate.deleted === 'boolean') &&
            (candidate.icon === undefined ||
              (typeof candidate.icon === 'string' && candidate.icon.length <= 8))
          );
        });
      const defaultIds = new Set<string>(DEFAULT_WRITING_STYLES.map((style) => style.id));
      const storedById = new Map(customStyles.map((style) => [style.id, style]));
      return [
        ...DEFAULT_WRITING_STYLES.map((style) => {
          const stored = storedById.get(style.id);
          // Defaults can be edited like any other row; the fixed ID keeps their
          // seeded identity so visibility and edits survive settings updates.
          if (stored === undefined) return style;
          const legacy = LEGACY_WRITING_STYLE_VALUES[style.id];
          const isUneditedLegacyDefault =
            legacy !== undefined &&
            stored.name === legacy.name &&
            stored.instruction === legacy.instruction;
          return {
            ...style,
            name: isUneditedLegacyDefault ? style.name : stored.name,
            description: isUneditedLegacyDefault
              ? style.description
              : (stored.description ?? style.description),
            instruction: isUneditedLegacyDefault ? style.instruction : stored.instruction,
            hidden: stored.hidden ?? ('hidden' in style ? style.hidden : undefined),
            deleted: stored.deleted,
            icon: stored.icon ?? style.icon,
          };
        }),
        ...customStyles.filter(
          (style) => !defaultIds.has(style.id) && !REMOVED_WRITING_STYLE_IDS.has(style.id),
        ),
      ];
    } catch {
      return DEFAULT_WRITING_STYLES;
    }
  }

  get activeWritingStyleId(): string | null {
    const value = this.#getSetting('active_writing_style_id');
    return value === null || !this.writingStyles.some((style) => style.id === value) ? null : value;
  }

  get usedModels(): readonly UsedModelReference[] {
    const value = this.#getSetting('used_models');
    if (value === null) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item) => {
        const result = usedModelReferenceSchema.safeParse(item);
        return result.success ? [result.data] : [];
      });
    } catch {
      return [];
    }
  }

  setShortcut(shortcut: string): void {
    this.#setSetting('shortcut', shortcut);
  }

  setGeneralSettings(
    historyEnabled: boolean,
    launchAtLogin: boolean,
    nativeLanguage: NativeLanguage | null = this.nativeLanguage,
    appearance: Appearance = this.appearance,
    otherLanguageTarget: OtherLanguageTarget = this.otherLanguageTarget,
    historyRetentionDays: HistoryRetentionDays = this.historyRetentionDays,
    writingStyles: readonly WritingStyle[] = this.writingStyles,
    activeWritingStyleId: string | null = this.activeWritingStyleId,
    enterToSend: boolean = this.enterToSend,
    translationStyle: TranslationStyle = this.translationStyle,
    debugMode: boolean = this.debugMode,
    onboardingCompleted: boolean = this.onboardingCompleted,
    compactTranslation: boolean = this.compactTranslation,
    developerMode: boolean = this.developerMode,
  ): void {
    const validActiveStyleId =
      activeWritingStyleId !== null &&
      writingStyles.some((style) => style.id === activeWritingStyleId)
        ? activeWritingStyleId
        : null;
    this.#database.transaction(() => {
      this.#setSetting('history_enabled', String(historyEnabled));
      this.#setSetting('launch_at_login', String(launchAtLogin));
      this.#setSetting('enter_to_send', String(enterToSend));
      this.#setSetting('compact_translation', String(compactTranslation));
      this.#setSetting('developer_mode', String(developerMode));
      this.#setSetting('debug_mode', String(debugMode));
      this.#setSetting('translation_style', translationStyle);
      this.#setSetting('native_language', nativeLanguage ?? '');
      this.#setSetting('appearance', appearance);
      this.#setSetting(
        'other_language_target',
        distinctTranslationTarget(nativeLanguage, otherLanguageTarget),
      );
      this.#setSetting(
        'history_retention_days',
        historyRetentionDays === null ? 'forever' : String(historyRetentionDays),
      );
      this.#setSetting('writing_styles', JSON.stringify(writingStyles));
      this.#setSetting('active_writing_style_id', validActiveStyleId ?? '');
      this.#setSetting('onboarding_completed', String(onboardingCompleted));
    });
  }

  setUsedModels(models: readonly UsedModelReference[]): void {
    const providers = new Map(this.listProviders().map((provider) => [provider.id, provider]));
    const seen = new Set<string>();
    for (const reference of models) {
      const provider = providers.get(reference.providerId);
      const key = `${reference.providerId}\u0000${reference.modelId}`;
      if (
        provider === undefined ||
        !provider.enabledModelIds.includes(reference.modelId) ||
        seen.has(key)
      ) {
        throw new Error('有効化されていないModelは使用できません。');
      }
      seen.add(key);
    }
    this.#setSetting('used_models', JSON.stringify(models));
  }

  listProviders(): readonly ProviderConnection[] {
    const rows = this.#database.connection
      .prepare(
        `SELECT id, config_json, encrypted_secret
         FROM providers
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as unknown as readonly ProfileRow[];
    const providers: ProviderConnection[] = [];
    for (const row of rows) {
      try {
        providers.push(this.#toStoredProvider(row).provider);
      } catch {
        // A malformed row is isolated instead of making every settings snapshot fail.
        // The raw row remains in SQLite for manual recovery; it is never activated or
        // exposed to the renderer until it satisfies the current schema again.
      }
    }
    return providers;
  }

  getProvider(providerId: string): StoredProviderConnection | null {
    const row = this.#database.connection
      .prepare(
        `SELECT id, config_json, encrypted_secret
         FROM providers
         WHERE id = ?`,
      )
      .get(providerId) as ProfileRow | undefined;
    return row === undefined ? null : this.#toStoredProvider(row);
  }

  saveProvider(
    definition: ProviderConnectionDefinition & { readonly id: string },
    secret: EncryptedSecretUpdate,
  ): ProviderConnection {
    const now = Date.now();
    return this.#database.transaction(() => {
      const existing = this.getProvider(definition.id);
      const encryptedSecret = (() => {
        switch (secret.action) {
          case 'preserve':
            return existing?.encryptedSecret ?? null;
          case 'clear':
            return null;
          case 'replace':
            return secret.value;
        }
      })();
      const stored = storedProviderConnectionSchema.parse(definition);
      this.#database.connection
        .prepare(
          `INSERT INTO providers
             (id, name, kind, config_json, encrypted_secret, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             kind = excluded.kind,
             config_json = excluded.config_json,
             encrypted_secret = excluded.encrypted_secret,
             updated_at = excluded.updated_at`,
        )
        .run(
          stored.id,
          stored.name,
          stored.kind,
          JSON.stringify(stored),
          encryptedSecret,
          now,
          now,
        );
      // 無効化したModelは使用順から同じtransactionで除外する。
      const nextUsedModels = this.usedModels.filter(
        (reference) =>
          reference.providerId !== stored.id || stored.enabledModelIds.includes(reference.modelId),
      );
      this.#setSetting('used_models', JSON.stringify(nextUsedModels));
      return { ...stored, hasApiKey: encryptedSecret !== null } as ProviderConnection;
    });
  }

  updateProviderSecret(providerId: string, encryptedSecret: Uint8Array): void {
    const result = this.#database.connection
      .prepare('UPDATE providers SET encrypted_secret = ?, updated_at = ? WHERE id = ?')
      .run(encryptedSecret, Date.now(), providerId);
    if (result.changes !== 1) throw new Error('ChatGPT Providerが見つかりません。');
  }

  deleteProvider(providerId: string): void {
    this.#database.transaction(() => {
      this.#database.connection.prepare('DELETE FROM providers WHERE id = ?').run(providerId);
      this.#setSetting(
        'used_models',
        JSON.stringify(this.usedModels.filter((model) => model.providerId !== providerId)),
      );
    });
  }

  #getSetting(key: string): string | null {
    const row = this.#database.connection
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as SettingRow | undefined;
    return row?.value ?? null;
  }

  #setSetting(key: string, value: string): void {
    this.#database.connection
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  #toStoredProvider(row: ProfileRow): StoredProviderConnection {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.config_json);
    } catch (error) {
      throw new Error(`Provider profile ${row.id} contains malformed JSON.`, { cause: error });
    }
    const definition = storedProviderConnectionSchema.parse(parsedJson);
    const encryptedSecret =
      row.encrypted_secret === null ? null : Buffer.from(row.encrypted_secret);
    return {
      provider: { ...definition, hasApiKey: encryptedSecret !== null } as ProviderConnection,
      encryptedSecret,
    };
  }
}
