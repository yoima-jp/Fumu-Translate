import { globalShortcut } from 'electron';
import log from 'electron-log/main';
import type { HotkeyRegistrationState } from '../../../shared/contracts';
import { HotkeyRepeatGuard } from './hotkey-repeat-guard';

export interface HotkeyRegistration {
  readonly accelerator: string;
  readonly state: HotkeyRegistrationState;
}

export class ElectronHotkeyService {
  readonly #logger = log.scope('hotkey');
  readonly #transientAccelerators = new Set<string>();
  readonly #repeatGuard = new HotkeyRepeatGuard();
  #accelerator: string | null = null;

  register(accelerator: string, callback: () => void): HotkeyRegistration {
    const normalized = accelerator.trim();
    if (normalized.length === 0) {
      this.unregister();
      return { accelerator: normalized, state: 'disabled' };
    }

    if (this.#accelerator === normalized && globalShortcut.isRegistered(normalized)) {
      return { accelerator: normalized, state: 'registered' };
    }

    try {
      // 新しい組合せを先に登録する。
      // 失敗時に現在動いているHotkeyまで失わないため、古い登録の解除は成功後に行う。
      if (!globalShortcut.register(normalized, () => this.#repeatGuard.push(callback))) {
        this.#logger.warn('Global shortcut registration failed', {
          accelerator: normalized,
        });
        return { accelerator: normalized, state: 'conflict' };
      }

      if (this.#accelerator !== null) {
        globalShortcut.unregister(this.#accelerator);
      }

      this.#accelerator = normalized;
      this.#repeatGuard.reset();
      this.#logger.info('Global shortcut registered', { accelerator: normalized });
      return { accelerator: normalized, state: 'registered' };
    } catch (error) {
      this.#logger.error('Global shortcut registration raised an error', {
        accelerator: normalized,
        error,
      });
      return { accelerator: normalized, state: 'invalid' };
    }
  }

  unregister(): void {
    if (this.#accelerator === null) {
      return;
    }

    globalShortcut.unregister(this.#accelerator);
    this.#repeatGuard.reset();
    this.#logger.info('Global shortcut unregistered', {
      accelerator: this.#accelerator,
    });
    this.#accelerator = null;
  }

  registerTransient(accelerator: string, callback: () => void): boolean {
    const normalized = accelerator.trim();
    if (normalized.length === 0) {
      return false;
    }

    if (this.#transientAccelerators.has(normalized)) {
      return true;
    }

    try {
      if (!globalShortcut.register(normalized, callback)) {
        this.#logger.warn('Transient shortcut registration failed', {
          accelerator: normalized,
        });
        return false;
      }
      this.#transientAccelerators.add(normalized);
      this.#logger.debug('Transient shortcut registered', {
        accelerator: normalized,
      });
      return true;
    } catch (error) {
      this.#logger.warn('Transient shortcut registration raised an error', {
        accelerator: normalized,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return false;
    }
  }

  unregisterTransient(accelerator: string): void {
    const normalized = accelerator.trim();
    if (!this.#transientAccelerators.delete(normalized)) {
      return;
    }

    globalShortcut.unregister(normalized);
    this.#logger.debug('Transient shortcut unregistered', {
      accelerator: normalized,
    });
  }

  suspend(): void {
    globalShortcut.setSuspended(true);
  }

  resume(): void {
    globalShortcut.setSuspended(false);
  }

  dispose(): void {
    this.#accelerator = null;
    this.#transientAccelerators.clear();
    this.#repeatGuard.reset();
    // setSuspended is process-global. Always reset it so a settings window that
    // closes mid-recording cannot leave Electron shortcuts disabled on teardown.
    try {
      globalShortcut.setSuspended(false);
    } finally {
      globalShortcut.unregisterAll();
    }
  }
}
