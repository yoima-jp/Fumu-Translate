import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { app, session, shell } from 'electron';
import log from 'electron-log/main';
import { resolveEnvironmentUiLocale, resolveUiLocale } from '@fumu/i18n';
import { MAX_TRANSLATION_SOURCE_CODE_POINTS } from '@fumu/translation-core';
import { AppController } from './app-controller';
import { registerIpcHandlers } from './ipc';
import { trustedRendererUrl } from './ipc-sender-policy';
import { isAutostartInvocation } from './launch-mode';
import { ElectronClipboardService } from './os/clipboard/electron-clipboard-service';
import { ElectronHotkeyService } from './os/hotkey/electron-hotkey-service';
import { SelectionHookService } from './os/selection/selection-hook-service';
import { MainWindowManager } from './os/windows/main-window-manager';
import { PopupWindowManager } from './os/windows/popup-window-manager';
import { ElectronStartupService } from './os/windows/electron-startup-service';
import { TrayManager } from './os/windows/tray-manager';
import { FumuDatabase } from './persistence/database';
import { HistoryRepository } from './persistence/history-repository';
import { SettingsRepository } from './persistence/settings-repository';
import { ElectronSecretStore } from './security/electron-secret-store';
import { SettingsService } from './settings/settings-service';
import {
  createLanguageServices,
  type LanguageServiceRegistry,
} from './translation/create-translation-service';

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';

const logger = log.scope('main');
const rendererUrl = trustedRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let controller: AppController | null = null;
let removeIpcHandlers: (() => void) | null = null;
let trayManager: TrayManager | null = null;
let removeTrayLocaleSubscription: (() => void) | null = null;
let database: FumuDatabase | null = null;
let languageServices: LanguageServiceRegistry | null = null;
let isQuitting = false;
let disposed = false;
let disposal: Promise<void> | null = null;
let fatalExitStarted = false;
const FATAL_CLEANUP_TIMEOUT_MS = 5_000;

function assertPackagedNotices(): void {
  if (!app.isPackaged) {
    return;
  }
  for (const name of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) {
    const path = join(process.resourcesPath, name);
    const stats = lstatSync(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size <= 0 ||
      stats.size > 32 * 1024 * 1024
    ) {
      throw new Error(`Packaged notice is missing or invalid: ${name}`);
    }
  }
}

function writeStartupRegistrationProbe(
  startup: ElectronStartupService,
  userDataPath: string,
): void {
  if (
    process.env.FUMU_E2E_STARTUP_PROBE !== '1' ||
    !app.commandLine.hasSwitch('fumu-e2e-startup-probe')
  ) {
    return;
  }

  const configuredPath = process.env.FUMU_E2E_STARTUP_PROBE_PATH?.trim() ?? '';
  const probePath = resolve(configuredPath);
  const relativeProbePath = relative(resolve(userDataPath), probePath);
  if (
    configuredPath.length === 0 ||
    relativeProbePath.length === 0 ||
    relativeProbePath.startsWith('..') ||
    isAbsolute(relativeProbePath)
  ) {
    throw new Error('Startup registration probe must stay inside the E2E user data directory.');
  }

  writeFileSync(probePath, `${JSON.stringify({ registrationPath: startup.registrationPath })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

async function startApplication(): Promise<void> {
  if (isQuitting || disposed) {
    return;
  }
  // Every distributable entry point must carry the notices used to satisfy OSS
  // obligations. Failing startup is safer than silently shipping an incomplete
  // portable or installed payload.
  assertPackagedNotices();
  app.setAppUserModelId('app.fumu.desktop');

  // Translation ProviderはMainからのみ呼び出すため、Rendererの権限要求はすべて拒否する。
  // 将来音声入力を足す場合も、用途と画面を定めてから個別に許可する。
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  const userDataPath = app.getPath('userData');
  const agentCwd = join(userDataPath, 'agent-workspace');
  mkdirSync(agentCwd, { recursive: true });

  const appDatabase = new FumuDatabase(join(userDataPath, 'fumu.sqlite3'));
  // Ownership is published immediately after construction. Any later startup failure
  // (including provider migration/parsing) is then covered by disposeApplication().
  database = appDatabase;
  const settingsRepository = new SettingsRepository(appDatabase);
  const historyRepository = new HistoryRepository(appDatabase);
  const registry = createLanguageServices(process.env, agentCwd);
  languageServices = registry;
  const startup = new ElectronStartupService();
  writeStartupRegistrationProbe(startup, userDataPath);
  const settings = new SettingsService(
    settingsRepository,
    new ElectronSecretStore(),
    startup,
    registry,
    (url) => shell.openExternal(url),
    undefined,
    resolveEnvironmentUiLocale(app.getPreferredSystemLanguages()),
  );
  const settingsError = settings.initialize();
  if (settingsError !== null) {
    logger.warn('Active provider could not be restored', {
      errorName: settingsError.name,
      message: settingsError.message,
    });
  }

  const mainWindow = new MainWindowManager(
    rendererUrl,
    !(app.isPackaged && app.commandLine.hasSwitch('autostart')),
  );
  const popupWindow = new PopupWindowManager(rendererUrl, undefined, (state) =>
    mainWindow.sendPopupState(state),
  );
  const appController = new AppController({
    clipboard: new ElectronClipboardService(),
    hotkey: new ElectronHotkeyService(),
    selection: new SelectionHookService({ maxCodePoints: MAX_TRANSLATION_SOURCE_CODE_POINTS }),
    translation: registry,
    followUp: registry,
    popup: popupWindow,
    mainWindow,
    settings,
    providers: registry,
    history: historyRepository,
  });

  controller = appController;
  removeIpcHandlers = registerIpcHandlers(appController, rendererUrl);
  await appController.initialize();
  if (isQuitting || appController.isDisposed || controller !== appController) {
    return;
  }

  const tray = new TrayManager(
    {
      showMainWindow: () => appController.showMainWindow(),
      translateClipboard: () => {
        void appController.triggerClipboard().catch((error: unknown) => {
          logger.error('Tray translation request escaped its error boundary', error);
        });
      },
      quit: () => app.quit(),
    },
    resolveUiLocale(settings.snapshot.nativeLanguage),
  );
  tray.initialize();
  trayManager = tray;
  // 母国語設定の変更をTray文言へ反映する。settings.subscribeはAppControllerも
  // 使うため、ここでは追加のlistenerとして購読し、shutdownで確実に解除する。
  removeTrayLocaleSubscription = settings.subscribe((snapshot) => {
    trayManager?.setLocale(resolveUiLocale(snapshot.nativeLanguage));
  });

  // Playwright injects a Node inspector into Electron and can itself keep the
  // instrumented process alive. Release E2E therefore launches a second, plain
  // product process with this explicit test hook to verify real shutdown.
  if (process.env.FUMU_E2E_AUTO_QUIT === '1' && app.commandLine.hasSwitch('fumu-e2e-auto-quit')) {
    setTimeout(() => app.quit(), 500);
  }
}

function disposeApplication(): Promise<void> {
  if (disposal !== null) {
    return disposal;
  }
  disposal = (async () => {
    logger.info('Application cleanup started');
    const errors: unknown[] = [];
    const cleanup = (action: (() => void) | null): void => {
      try {
        action?.();
      } catch (error) {
        errors.push(error);
      }
    };

    const removeHandlers = removeIpcHandlers;
    removeIpcHandlers = null;
    cleanup(removeHandlers);
    logger.info('IPC handlers removed');
    const removeLocaleSubscription = removeTrayLocaleSubscription;
    removeTrayLocaleSubscription = null;
    cleanup(removeLocaleSubscription);
    logger.info('Tray locale subscription removed');
    const tray = trayManager;
    trayManager = null;
    cleanup(tray === null ? null : () => tray.dispose());
    logger.info('Tray disposed');
    const activeController = controller;
    controller = null;
    if (activeController !== null) {
      try {
        await activeController.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    logger.info('App controller disposed');
    const services = languageServices;
    languageServices = null;
    if (services !== null) {
      try {
        await services.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    logger.info('Language services disposed');
    const activeDatabase = database;
    database = null;
    cleanup(activeDatabase === null ? null : () => activeDatabase.close());
    logger.info('Database closed');
    disposed = true;
    logger.info('Application cleanup completed', { errorCount: errors.length });
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more Fumu resources could not be disposed.');
    }
  })();
  return disposal;
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Windows can race a delayed Startup launch with an already-running tray
    // instance. That second invocation must remain silent just like a fresh
    // --autostart process; ordinary user launches still restore the main window.
    if (!isAutostartInvocation(commandLine)) {
      controller?.showMainWindow();
    }
  });

  app
    .whenReady()
    .then(startApplication)
    .catch(async (error: unknown) => {
      if (isQuitting || disposed) {
        logger.info('Application startup stopped during shutdown');
        return;
      }
      logger.error('Application startup failed', error);
      await disposeApplication().catch((cleanupError: unknown) => {
        logger.error('Application cleanup after startup failure was incomplete', cleanupError);
      });
      app.exit(1);
    });

  app.on('activate', () => {
    controller?.showMainWindow();
  });

  app.on('window-all-closed', () => {
    // During the first, vetoed quit pass AppController destroys both windows.
    // Electron's default window-all-closed action would stop Chromium's main loop
    // before asynchronous Worker teardown settles and before the retry can run.
    // Unexpected window loss still quits; controlled shutdown is retried below.
    if (!isQuitting) {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    logger.info('Electron will quit');
  });
  app.on('quit', (_event, exitCode) => {
    logger.info('Electron quit event', { exitCode });
  });

  app.on('before-quit', (event) => {
    if (disposed) {
      return;
    }
    event.preventDefault();
    if (isQuitting) {
      return;
    }
    isQuitting = true;
    void disposeApplication()
      .catch((error: unknown) => {
        // Cleanup errors must not turn before-quit into a permanent quit veto.
        // Resources are isolated above, and disposed is set before this path runs.
        logger.error('Application cleanup was incomplete', error);
      })
      // The original quit was cancelled while asynchronous resources were being
      // released. Worker termination is awaited by disposeApplication, so retry
      // synchronously while the Electron main loop is still available. `disposed`
      // makes the next before-quit pass through without another veto.
      .finally(() => {
        logger.info('Application quit retried after cleanup');
        app.quit();
      });
  });
}

function exitAfterFatalError(label: string, error: unknown): void {
  logger.error(label, error);
  if (fatalExitStarted) return;

  // uncaughtException後のNode processは安全に継続できない。通常終了と同じ資源回収を
  // 試みるが、壊れたWorkerやDBが停止していても無限に待たない。
  fatalExitStarted = true;
  isQuitting = true;
  const forcedExit = setTimeout(() => app.exit(1), FATAL_CLEANUP_TIMEOUT_MS);
  forcedExit.unref();
  void disposeApplication()
    .catch((cleanupError: unknown) => {
      logger.error('Application cleanup after a fatal error was incomplete', cleanupError);
    })
    .finally(() => {
      clearTimeout(forcedExit);
      app.exit(1);
    });
}

process.on('uncaughtException', (error) => exitAfterFatalError('Uncaught exception', error));
process.on('unhandledRejection', (reason) => exitAfterFatalError('Unhandled rejection', reason));
