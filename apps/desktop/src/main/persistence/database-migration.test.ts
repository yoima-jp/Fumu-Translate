import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FumuDatabase } from './database';
import { SettingsRepository } from './settings-repository';

describe('provider/model database migration', () => {
  it('migrates an active v1 provider through the current schema without losing its secret', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fumu-provider-migration-'));
    const path = join(directory, 'fumu.db');
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        CREATE TABLE provider_profiles (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          config_json TEXT NOT NULL,
          encrypted_secret BLOB,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE translation_results (
          id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          result_json TEXT NOT NULL,
          provider_profile_id TEXT,
          provider_name TEXT,
          created_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      const id = '00000000-0000-4000-8000-000000000001';
      legacy
        .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
        .run('active_provider_id', id);
      legacy
        .prepare(
          `INSERT INTO provider_profiles
          (id, name, kind, config_json, encrypted_secret, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          'Legacy OpenAI',
          'openai',
          JSON.stringify({ id, name: 'Legacy OpenAI', kind: 'openai', model: 'gpt-legacy' }),
          Buffer.from('encrypted'),
          1,
          1,
        );
      legacy.close();

      const database = new FumuDatabase(path);
      const repository = new SettingsRepository(database);
      expect(repository.usedModels).toEqual([{ providerId: id, modelId: 'gpt-legacy' }]);
      const backup = database.connection
        .prepare('SELECT encrypted_secret FROM legacy_provider_profiles_v1_backup WHERE id = ?')
        .get(id) as { encrypted_secret: Uint8Array };
      expect(Buffer.from(backup.encrypted_secret).toString()).toBe('encrypted');
      expect(
        (database.connection.prepare('PRAGMA user_version').get() as { user_version: number })
          .user_version,
      ).toBe(4);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
