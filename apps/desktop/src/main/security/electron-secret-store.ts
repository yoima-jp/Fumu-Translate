import { safeStorage } from 'electron';

export interface SecretStore {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class ElectronSecretStore implements SecretStore {
  encrypt(value: string): Buffer {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windowsの暗号化ストレージを利用できません。');
    }
    return safeStorage.encryptString(value);
  }

  decrypt(value: Buffer): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windowsの暗号化ストレージを利用できません。');
    }
    return safeStorage.decryptString(value);
  }
}
