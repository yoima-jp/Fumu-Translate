import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 4;

interface UserVersionRow {
  readonly user_version: number;
}

export class FumuDatabase {
  readonly connection: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.connection = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.#migrate();
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.connection.exec('COMMIT');
      return value;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.connection.close();
  }

  #migrate(): void {
    const row = this.connection.prepare('PRAGMA user_version').get() as UserVersionRow | undefined;
    const currentVersion = row?.user_version ?? 0;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `Fumu database schema ${String(currentVersion)} is newer than supported ${String(SCHEMA_VERSION)}.`,
      );
    }
    if (currentVersion === 0) {
      this.transaction(() => {
        this.connection.exec(`
          CREATE TABLE app_settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
          );

          CREATE TABLE providers (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            config_json TEXT NOT NULL,
            encrypted_secret BLOB,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE translation_sessions (
            id TEXT PRIMARY KEY NOT NULL,
            source_text TEXT NOT NULL,
            program_name TEXT,
            selection_method TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE translation_results (
            id TEXT PRIMARY KEY NOT NULL,
            session_id TEXT NOT NULL REFERENCES translation_sessions(id) ON DELETE CASCADE,
            request_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            result_json TEXT NOT NULL,
            provider_profile_id TEXT,
            provider_name TEXT,
            provider_model_id TEXT,
            source_text TEXT,
            conversation_direction TEXT CHECK(conversation_direction IN ('incoming', 'outgoing')),
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, request_id)
          );

          CREATE TABLE follow_up_messages (
            id TEXT PRIMARY KEY NOT NULL,
            session_id TEXT NOT NULL REFERENCES translation_sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );

          CREATE INDEX translation_sessions_updated_at_idx
            ON translation_sessions(updated_at DESC);
          CREATE INDEX translation_results_session_idx
            ON translation_results(session_id, created_at ASC);
          CREATE INDEX follow_up_messages_session_idx
            ON follow_up_messages(session_id, created_at ASC);

          PRAGMA user_version = 4;
        `);
      });
      return;
    }
    if (currentVersion === 1) {
      this.#migrateProviderModels();
      this.#migrateHistoryModel();
      this.#migrateConversationHistory();
    } else if (currentVersion === 2) {
      this.#migrateHistoryModel();
      this.#migrateConversationHistory();
    } else if (currentVersion === 3) {
      this.#migrateConversationHistory();
    }
  }

  #migrateConversationHistory(): void {
    this.transaction(() => {
      // 会話は一つのsessionに複数の原文を持つため、結果行側にもターン情報を置く。
      // NULLは旧履歴と通常翻訳を表し、従来のsession.source_textへフォールバックできる。
      this.connection.exec(`
        ALTER TABLE translation_results ADD COLUMN source_text TEXT;
        ALTER TABLE translation_results ADD COLUMN conversation_direction TEXT
          CHECK(conversation_direction IN ('incoming', 'outgoing'));
        PRAGMA user_version = 4;
      `);
    });
  }

  #migrateHistoryModel(): void {
    this.transaction(() => {
      this.connection.exec(`
        ALTER TABLE translation_results ADD COLUMN provider_model_id TEXT;
        PRAGMA user_version = 3;
      `);
    });
  }

  #migrateProviderModels(): void {
    interface LegacyProviderRow {
      readonly id: string;
      readonly config_json: string;
    }
    interface ActiveProviderRow {
      readonly value: string;
    }
    interface ConfigRow {
      readonly config_json: string;
    }

    this.transaction(() => {
      // Provider API形式へ変換できないCodex/ACP設定や壊れたJSONも、ユーザーが
      // 復旧できるよう暗号化済み秘密値を含むv1行を変更前の形で保持する。
      this.connection.exec(`
        CREATE TABLE legacy_provider_profiles_v1_backup AS
        SELECT * FROM provider_profiles;
      `);
      const rows = this.connection
        .prepare('SELECT id, config_json FROM provider_profiles')
        .all() as unknown as readonly LegacyProviderRow[];
      const migratedIds = new Set<string>();
      for (const row of rows) {
        let legacy: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(row.config_json);
          if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
          legacy = parsed as Record<string, unknown>;
        } catch {
          // 壊れた旧行を新schemaのProviderとして見せない。秘密値を含む可能性があるため、
          // JSONをログへ出さず行だけを除外する。
          this.connection.prepare('DELETE FROM provider_profiles WHERE id = ?').run(row.id);
          continue;
        }
        const modelId = typeof legacy.model === 'string' ? legacy.model.trim() : '';
        const oldKind = typeof legacy.kind === 'string' ? legacy.kind : '';
        const common = {
          id: row.id,
          name:
            typeof legacy.name === 'string' && legacy.name.trim() ? legacy.name.trim() : 'Provider',
          models:
            modelId.length === 0 ? [] : [{ id: modelId, metadata: {}, source: 'manual' as const }],
          enabledModelIds: modelId.length === 0 ? [] : [modelId],
        };
        const migrated = (() => {
          if (oldKind === 'openai' || oldKind === 'anthropic' || oldKind === 'google') {
            return { ...common, kind: oldKind };
          }
          if (oldKind === 'deepseek') {
            return {
              ...common,
              kind: 'custom-openai-compatible',
              baseUrl: 'https://api.deepseek.com/',
              supportsJsonObjectResponse: true,
              includeUsage: true,
            };
          }
          if (oldKind === 'openai-compatible' && typeof legacy.baseUrl === 'string') {
            return {
              ...common,
              kind: 'custom-openai-compatible',
              baseUrl: legacy.baseUrl,
              supportsJsonObjectResponse: legacy.supportsJsonObjectResponse === true,
              includeUsage: legacy.includeUsage === true,
            };
          }
          return null;
        })();
        if (migrated === null || modelId.length === 0) {
          // Codex/ACPのコマンド実行設定はProvider API接続へ安全に変換できない。
          this.connection.prepare('DELETE FROM provider_profiles WHERE id = ?').run(row.id);
          continue;
        }
        this.connection
          .prepare(
            'UPDATE provider_profiles SET kind = ?, config_json = ?, updated_at = ? WHERE id = ?',
          )
          .run(migrated.kind, JSON.stringify(migrated), Date.now(), row.id);
        migratedIds.add(row.id);
      }

      const active = this.connection
        .prepare("SELECT value FROM app_settings WHERE key = 'active_provider_id'")
        .get() as ActiveProviderRow | undefined;
      const activeId = active?.value ?? '';
      const activeProvider = rows.find((row) => row.id === activeId);
      let usedModels = '[]';
      if (activeProvider !== undefined && migratedIds.has(activeId)) {
        const config = this.connection
          .prepare('SELECT config_json FROM provider_profiles WHERE id = ?')
          .get(activeId) as ConfigRow | undefined;
        const parsed = JSON.parse(config?.config_json ?? '{}') as { enabledModelIds?: unknown };
        const modelId = Array.isArray(parsed.enabledModelIds)
          ? parsed.enabledModelIds[0]
          : undefined;
        if (typeof modelId === 'string')
          usedModels = JSON.stringify([{ providerId: activeId, modelId }]);
      }
      this.connection
        .prepare(
          `INSERT INTO app_settings (key, value) VALUES ('used_models', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(usedModels);
      this.connection.prepare("DELETE FROM app_settings WHERE key = 'active_provider_id'").run();
      this.connection.exec('ALTER TABLE provider_profiles RENAME TO providers;');
      this.connection.exec('PRAGMA user_version = 2;');
    });
  }
}
