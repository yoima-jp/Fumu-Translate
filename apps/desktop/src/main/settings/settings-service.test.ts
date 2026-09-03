import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnectionDefinition } from '../../shared/settings-contracts';
import type { StartupService } from '../os/windows/electron-startup-service';
import { FumuDatabase } from '../persistence/database';
import { SettingsRepository } from '../persistence/settings-repository';
import type { SecretStore } from '../security/electron-secret-store';
import {
  SettingsService,
  type ProviderActivationPort,
  type RuntimeModel,
} from './settings-service';

class MemorySecrets implements SecretStore {
  encrypt(value: string): Buffer {
    return Buffer.from(value);
  }

  decrypt(value: Buffer): string {
    return value.toString();
  }
}

class MemoryStartup implements StartupService {
  supported = true;
  enabled = false;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

class FakeProviders implements ProviderActivationPort {
  models: readonly RuntimeModel[] = [];

  get configured(): boolean {
    return this.models.length > 0;
  }

  get activeProviderName(): string | null {
    return this.models[0]?.provider.name ?? null;
  }

  get activeModelName(): string | null {
    return this.models[0]?.modelId ?? null;
  }

  consumeCompletedModel(): null {
    return null;
  }

  validate(): void {}

  configure(models: readonly RuntimeModel[]): void {
    this.models = [...models];
  }
}

const provider: ProviderConnectionDefinition = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'OpenAI',
  kind: 'openai',
  models: [{ id: 'model-a', metadata: {}, source: 'manual' }],
  enabledModelIds: ['model-a'],
};

function setup(
  chatGptLogin?: ConstructorParameters<typeof SettingsService>[5],
  environmentUiLocale?: ConstructorParameters<typeof SettingsService>[6],
) {
  const database = new FumuDatabase(':memory:');
  const repository = new SettingsRepository(database);
  const providers = new FakeProviders();
  const service = new SettingsService(
    repository,
    new MemorySecrets(),
    new MemoryStartup(),
    providers,
    () => undefined,
    chatGptLogin,
    environmentUiLocale,
  );
  return { database, repository, providers, service };
}

describe('SettingsService credential boundaries', () => {
  it('does not reuse a saved key for a different provider credential scope', async () => {
    const test = setup();
    test.service.saveProvider({ provider, secret: { action: 'replace', apiKey: 'secret' } });

    await expect(
      test.service.fetchModels({
        provider: {
          ...provider,
          kind: 'custom-openai-compatible',
          baseUrl: 'https://attacker.example/v1/',
          supportsJsonObjectResponse: true,
          includeUsage: true,
        },
        secret: { action: 'preserve' },
      }),
    ).rejects.toThrow(/再入力/u);
    test.database.close();
  });

  it('keeps ChatGPT credentials in main storage and persists rotations', async () => {
    const credential = JSON.stringify({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-id',
    });
    const chatGptLogin = vi.fn(async () => credential);
    const test = setup(chatGptLogin, 'ja');
    const chatGpt: ProviderConnectionDefinition = {
      id: '00000000-0000-4000-8000-000000000009',
      name: 'ChatGPT',
      kind: 'chatgpt',
      models: [{ id: 'gpt-test', metadata: {}, source: 'manual' }],
      enabledModelIds: ['gpt-test'],
    };

    await test.service.loginChatGpt(chatGpt.id!);
    expect(chatGptLogin).toHaveBeenCalledWith(expect.objectContaining({ locale: 'ja' }));
    test.service.saveProvider({ provider: chatGpt, secret: { action: 'preserve' } });
    test.service.updateUsedModels({
      models: [{ providerId: chatGpt.id!, modelId: 'gpt-test' }],
    });
    expect(test.providers.models[0]?.apiKey).toBe(credential);
    test.providers.models[0]?.updateCredential?.('rotated-credential');
    expect(test.repository.getProvider(chatGpt.id!)?.encryptedSecret?.toString()).toBe(
      'rotated-credential',
    );
    test.database.close();
  });
});
