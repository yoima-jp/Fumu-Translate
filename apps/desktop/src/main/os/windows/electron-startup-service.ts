import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { app } from 'electron';

export interface LoginItemApplication {
  readonly isPackaged: boolean;
  getLoginItemSettings(settings?: { readonly path: string; readonly args: string[] }): {
    readonly openAtLogin: boolean;
  };
  setLoginItemSettings(settings: {
    readonly openAtLogin: boolean;
    readonly path: string;
    readonly args: string[];
  }): void;
}

const LOGIN_ARGUMENTS = ['--autostart'] as const;

export interface StartupRuntime {
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
}

export interface StartupService {
  readonly supported: boolean;
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
}

export function resolveStartupExecutablePath(
  defaultExecutablePath: string,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = existsSync,
): string {
  const portableExecutable = environment.PORTABLE_EXECUTABLE_FILE?.trim() ?? '';
  if (
    portableExecutable.length === 0 ||
    portableExecutable.length > 32_767 ||
    portableExecutable.includes('\0') ||
    !isAbsolute(portableExecutable) ||
    !portableExecutable.toLowerCase().endsWith('.exe') ||
    !fileExists(portableExecutable)
  ) {
    return defaultExecutablePath;
  }

  // electron-builder's portable launcher extracts the real app into a temporary
  // directory. Registering process.execPath would leave a dead login item after
  // that directory is removed, so retain the original launcher path instead.
  return portableExecutable;
}

export class ElectronStartupService implements StartupService {
  readonly #application: LoginItemApplication;
  readonly #runtime: StartupRuntime;

  constructor(
    application: LoginItemApplication = app,
    runtime: StartupRuntime = {
      platform: process.platform,
      executablePath: resolveStartupExecutablePath(process.execPath),
    },
  ) {
    this.#application = application;
    this.#runtime = runtime;
  }

  get supported(): boolean {
    return this.#runtime.platform === 'win32' && this.#application.isPackaged;
  }

  get enabled(): boolean {
    return (
      this.supported &&
      this.#application.getLoginItemSettings({
        path: this.#runtime.executablePath,
        args: [...LOGIN_ARGUMENTS],
      }).openAtLogin
    );
  }

  get registrationPath(): string {
    return this.#runtime.executablePath;
  }

  setEnabled(enabled: boolean): void {
    if (!this.supported) {
      if (enabled) {
        throw new Error('自動起動はパッケージ版で設定できます。');
      }
      return;
    }

    this.#application.setLoginItemSettings({
      openAtLogin: enabled,
      path: this.#runtime.executablePath,
      args: [...LOGIN_ARGUMENTS],
    });
  }
}
