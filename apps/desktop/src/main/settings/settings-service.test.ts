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
  failDecrypt = false;

  encrypt(value: string): Buffer {
    return Buffer.from(value);
  }

  decrypt(value: Buffer): string {
    if (this.failDecrypt) throw new Error('Credential cannot be decrypted.');
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
  const secrets = new MemorySecrets();
  const onProviderActivationFailure = vi.fn();
  const service = new SettingsService(
    repository,
    secrets,
    new MemoryStartup(),
    providers,
    () => undefined,
    chatGptLogin,
    environmentUiLocale,
    onProviderActivationFailure,
  );
  return { database, repository, providers, secrets, onProviderActivationFailure, service };
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

  it('saves a new provider even when an unrelated active provider credential is unreadable', () => {
    const test = setup();
    const brokenChatGptId = '00000000-0000-4000-8000-000000000010';
    const brokenChatGpt = {
      id: brokenChatGptId,
      name: 'ChatGPT',
      kind: 'chatgpt' as const,
      models: [{ id: 'gpt-old', metadata: {}, source: 'manual' as const }],
      enabledModelIds: ['gpt-old'],
    };
    test.repository.saveProvider(brokenChatGpt, {
      action: 'replace',
      value: Buffer.from('unreadable'),
    });
    test.repository.setUsedModels([{ providerId: brokenChatGptId, modelId: 'gpt-old' }]);
    test.secrets.failDecrypt = true;

    const localProviderId = '00000000-0000-4000-8000-000000000011';
    const localProvider: ProviderConnectionDefinition = {
      id: localProviderId,
      name: 'Ollama',
      kind: 'ollama',
      baseUrl: 'http://localhost:11434/',
      models: [{ id: 'llama3', metadata: {}, source: 'manual' }],
      enabledModelIds: ['llama3'],
    };
    const snapshot = test.service.saveProvider({
      provider: localProvider,
      secret: { action: 'clear' },
    });

    expect(snapshot.providers.map((item) => item.id)).toContain(localProvider.id);
    expect(test.repository.getProvider(localProviderId)?.provider.name).toBe('Ollama');
    expect(test.onProviderActivationFailure).toHaveBeenCalledOnce();
    expect(test.providers.models).toEqual([]);
    test.database.close();
  });
});
