import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { createE2eEvidenceContext } from './e2e-evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const packagedExecutable = process.env.FUMU_E2E_EXECUTABLE?.trim() || null;
const evidence = await createE2eEvidenceContext({
  root,
  kind: 'phase5',
  packagedExecutable,
});
const screenshots = [];
const userData = await mkdtemp(join(tmpdir(), 'fumu-phase5-'));
const providerPort = '43122';
const provider = spawn(process.execPath, ['tools/mock-openai-provider.mjs'], {
  cwd: root,
  env: { ...process.env, FUMU_MOCK_PROVIDER_PORT: providerPort },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

function progress(step) {
  process.stdout.write(`[phase5-e2e] ${step}\n`);
}

async function terminateProcessTree(child) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }
  await new Promise((resolveTerminate) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => resolveTerminate());
    killer.once('exit', () => resolveTerminate());
  });
}

async function waitForProvider() {
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Mock provider startup timed out.')), 5_000);
    provider.once('error', reject);
    provider.once('exit', (code) => reject(new Error(`Mock provider exited: ${String(code)}`)));
    provider.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
  });
}

async function waitForWindow(application, kind) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = application
      .windows()
      .find((candidate) => candidate.url().includes(`window=${kind}`));
    if (page) return page;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`${kind} window was not created.`);
}

async function waitForNativeStatus(page) {
  const deadline = Date.now() + 10_000;
  let status = null;
  while (Date.now() < deadline) {
    status = await page.evaluate(() => window.fumu.getStatus());
    if (status.selectionServiceRunning && status.hotkeyState === 'registered') return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Native integration was not ready: ${JSON.stringify(status)}`);
}

async function verifyPlainProductShutdown() {
  const executable =
    packagedExecutable === null
      ? resolve(root, 'node_modules', 'electron', 'dist', 'electron.exe')
      : resolve(root, packagedExecutable);
  const args =
    packagedExecutable === null
      ? ['apps/desktop', `--user-data-dir=${userData}`, '--fumu-e2e-auto-quit']
      : [`--user-data-dir=${userData}`, '--fumu-e2e-auto-quit'];
  const product = spawn(executable, args, {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      FUMU_E2E_AUTO_QUIT: '1',
      ...(packagedExecutable === null
        ? {}
        : { ELECTRON_RENDERER_URL: 'https://attacker.invalid/renderer' }),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const outcome = await Promise.race([
    new Promise((resolveExit) => {
      product.once('error', (error) => resolveExit({ kind: 'error', error }));
      product.once('exit', (code, signal) => resolveExit({ kind: 'exit', code, signal }));
    }),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ kind: 'timeout' }), 10_000)),
  ]);
  if (outcome.kind === 'exit' && outcome.code === 0) {
    return true;
  }
  await terminateProcessTree(product);
  process.stderr.write(`[phase5-e2e] plain product shutdown failed: ${JSON.stringify(outcome)}\n`);
  return false;
}

async function verifyPackagedAutostartHidden() {
  if (packagedExecutable === null) return 'development-not-applicable';
  const autostartUserData = await mkdtemp(join(tmpdir(), 'fumu-autostart-'));
  let autostartApplication;
  try {
    autostartApplication = await electron.launch({
      executablePath: resolve(root, packagedExecutable),
      args: [`--user-data-dir=${autostartUserData}`, '--autostart'],
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const hiddenMain = await waitForWindow(autostartApplication, 'main');
    await waitForNativeStatus(hiddenMain);
    const visibility = await autostartApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes('window=main'),
      );
      return {
        exists: mainWindow !== undefined,
        visible: mainWindow?.isVisible() ?? true,
      };
    });
    if (!visibility.exists || visibility.visible) {
      throw new Error(`Autostart displayed the Main Window: ${JSON.stringify(visibility)}`);
    }
    return true;
  } finally {
    await autostartApplication?.close().catch(() => undefined);
    await rm(autostartUserData, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyExistingInstanceAutostartHidden(application) {
  if (packagedExecutable === null) return 'development-not-applicable';
  const second = spawn(
    resolve(root, packagedExecutable),
    [`--user-data-dir=${userData}`, '--autostart'],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  const outcome = await Promise.race([
    new Promise((resolveExit) => {
      second.once('error', (error) => resolveExit({ kind: 'error', error }));
      second.once('exit', (code) => resolveExit({ kind: 'exit', code }));
    }),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ kind: 'timeout' }), 5_000)),
  ]);
  if (outcome.kind !== 'exit' || outcome.code !== 0) {
    await terminateProcessTree(second);
    throw new Error(`Autostart second instance did not exit cleanly: ${JSON.stringify(outcome)}`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const visible = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (window) => window.webContents.getURL().includes('window=main') && window.isVisible(),
    ),
  );
  if (visible) throw new Error('Autostart second instance displayed the Main Window.');
  return true;
}

let application;
let failure = null;
let result = null;
let gracefulQuit = false;
let automationProcessClosed = false;
let startupRestore = null;
try {
  await waitForProvider();
  progress('provider-ready');
  application = await electron.launch({
    ...(packagedExecutable === null
      ? { args: ['apps/desktop', `--user-data-dir=${userData}`] }
      : {
          executablePath: resolve(root, packagedExecutable),
          args: [`--user-data-dir=${userData}`],
        }),
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      FUMU_OPENAI_BASE_URL: '',
      FUMU_OPENAI_MODEL: '',
      FUMU_OPENAI_API_KEY: '',
      ...(packagedExecutable === null
        ? {}
        : { ELECTRON_RENDERER_URL: 'https://attacker.invalid/renderer' }),
    },
  });
  progress('electron-launched');

  const main = await waitForWindow(application, 'main');
  const popup = await waitForWindow(application, 'popup');
  await main.evaluate(() =>
    window.fumu.updateGeneralSettings({ onboardingCompleted: true, nativeLanguage: 'Japanese' }),
  );
  await main.locator('.onboarding-shell').waitFor({ state: 'detached' });
  const packagedRendererEnvironmentIgnored =
    packagedExecutable === null ? 'development' : main.url().startsWith('file:');
  if (packagedRendererEnvironmentIgnored === false) {
    throw new Error(`Packaged renderer escaped the bundled file: origin: ${main.url()}`);
  }
  progress('windows-ready');
  await waitForNativeStatus(main);
  await main.getByRole('button', { name: '設定', exact: true }).click();
  await main.getByRole('heading', { name: '一般', exact: true }).waitFor();

  await main
    .locator('.settings-section', { hasText: 'モデル' })
    .getByRole('button', { name: '管理', exact: true })
    .click();
  await main.getByRole('dialog', { name: 'モデルを管理' }).waitFor();
  await main.getByRole('button', { name: '追加', exact: true }).first().click();
  await main.getByText('カスタムプロバイダー', { exact: true }).locator('..').locator('..').click();
  await main.getByLabel('名前').fill('E2E Local');
  await main.getByLabel('接続先').fill(`http://127.0.0.1:${providerPort}/v1/`);
  await main.getByPlaceholder('Model ID').fill('mock-model');
  await main.locator('.manual-model-add').getByRole('button', { name: '追加' }).click();
  await main.getByRole('button', { name: '保存', exact: true }).click();
  await main.getByText('E2E Local / mock-model', { exact: true }).waitFor();
  await main.getByRole('button', { name: '戻る', exact: true }).click();
  await main.getByRole('heading', { name: '一般', exact: true }).waitFor();
  progress('provider-saved');

  const recorder = main.getByRole('button', { name: '翻訳ショートカットを記録' });
  await recorder.click();
  await main
    .getByRole('status')
    .getByText('キーの組み合わせを押してください。', { exact: true })
    .waitFor();
  await main.keyboard.press('Control+Alt+F10');
  await main.getByText('Ctrl + Alt + F10', { exact: true }).waitFor();
  progress('shortcut-saved');

  const startup = await main.evaluate(async () => {
    const initial = await window.fumu.getSettings();
    if (!initial.startupSupported) return { supported: false, toggled: false, initial: false };
    const toggled = !initial.launchAtLogin;
    const updated = await window.fumu.updateGeneralSettings({
      historyEnabled: initial.historyEnabled,
      launchAtLogin: toggled,
      nativeLanguage: initial.nativeLanguage,
    });
    return {
      supported: true,
      toggled: updated.launchAtLogin === toggled,
      initial: initial.launchAtLogin,
      historyEnabled: initial.historyEnabled,
      nativeLanguage: initial.nativeLanguage,
    };
  });
  if (startup.supported) {
    if (!startup.toggled) throw new Error('Packaged startup setting did not change.');
    startupRestore = {
      launchAtLogin: startup.initial,
      historyEnabled: startup.historyEnabled,
      nativeLanguage: startup.nativeLanguage,
    };
    await main.evaluate((settings) => window.fumu.updateGeneralSettings(settings), startupRestore);
    startupRestore = null;
    progress('startup-toggled');
  }
  const settingsScreenshot = evidence.screenshotPath('settings.png');
  await main.screenshot({ path: settingsScreenshot });
  screenshots.push(settingsScreenshot);
  await main.getByRole('button', { name: '閉じる', exact: true }).click();

  await application.evaluate(
    ({ clipboard }, value) => clipboard.writeText(value),
    'Hello from Phase 5',
  );
  await main.evaluate(() => window.fumu.triggerClipboard());
  await popup
    .getByText('「Hello from Phase 5」の翻訳です。', { exact: true })
    .waitFor({ timeout: 10_000 });
  await popup.getByText('翻訳しました', { exact: true }).waitFor({ timeout: 10_000 });
  const popupOwnsKeyboardFocus = await popup.evaluate(() => document.hasFocus());
  if (!popupOwnsKeyboardFocus) {
    throw new Error('Completed selection popup did not receive keyboard focus.');
  }
  await popup.keyboard.press('Tab');
  const popupKeyboardTarget = await popup.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement
      ? {
          tagName: active.tagName,
          disabled: 'disabled' in active ? Boolean(active.disabled) : false,
          label: active.getAttribute('aria-label') ?? active.textContent?.trim() ?? '',
        }
      : null;
  });
  if (
    popupKeyboardTarget === null ||
    !['BUTTON', 'INPUT', 'TEXTAREA', 'A'].includes(popupKeyboardTarget.tagName) ||
    popupKeyboardTarget.disabled
  ) {
    throw new Error(`Popup Tab navigation failed: ${JSON.stringify(popupKeyboardTarget)}`);
  }
  await popup.getByRole('button', { name: '調整', exact: true }).click();
  await popup.getByRole('menu', { name: '翻訳を調整', exact: true }).waitFor();
  await popup.waitForTimeout(200);
  const adjustmentMenuVisible = await popup.locator('.adjustment-menu').isVisible();
  if (!adjustmentMenuVisible) throw new Error('Translation adjustment menu did not open.');
  const adjustmentMenuGap = await popup.evaluate(() => {
    const trigger = document.querySelector('.adjustment-trigger')?.getBoundingClientRect();
    const menu = document.querySelector('.adjustment-menu')?.getBoundingClientRect();
    if (trigger === undefined || menu === undefined) return null;
    return menu.bottom <= trigger.top ? trigger.top - menu.bottom : menu.top - trigger.bottom;
  });
  if (adjustmentMenuGap === null || Math.abs(adjustmentMenuGap - 9) > 1) {
    throw new Error(`Translation adjustment menu gap is incorrect: ${adjustmentMenuGap}`);
  }
  progress('translation-complete');
  const popupScreenshot = evidence.screenshotPath('popup.png');
  await popup.screenshot({ path: popupScreenshot });
  screenshots.push(popupScreenshot);

  await popup.getByRole('button', { name: '閉じる', exact: true }).click();
  await main.getByRole('button', { name: 'Hello from Phase 5', exact: true }).click();
  await main.getByText('「Hello from Phase 5」の翻訳です。', { exact: true }).first().waitFor();
  progress('history-visible');
  const historyScreenshot = evidence.screenshotPath('history.png');
  await main.screenshot({ path: historyScreenshot });
  screenshots.push(historyScreenshot);

  const visibleBeforeClose = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (window) => window.webContents.getURL().includes('window=main') && window.isVisible(),
    ),
  );
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('window=main'))
      ?.close();
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const hiddenAfterClose = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (window) => window.webContents.getURL().includes('window=main') && !window.isVisible(),
    ),
  );
  const processAlive = await application.evaluate(({ app }) => app.isReady());
  const existingInstanceAutostartHidden = await verifyExistingInstanceAutostartHidden(application);

  result = {
    provider: true,
    shortcut: true,
    startup: startup.supported ? startup.toggled : 'development-not-supported',
    translation: true,
    adjustmentMenuVisible,
    adjustmentMenuGap,
    popupOwnsKeyboardFocus,
    popupKeyboardTarget,
    history: true,
    nativeStatus: true,
    visibleBeforeClose,
    hiddenAfterClose,
    processAlive,
    existingInstanceAutostartHidden,
    packagedRendererEnvironmentIgnored,
  };
} catch (error) {
  failure = error;
} finally {
  if (application) {
    if (startupRestore !== null) {
      const page = application
        .windows()
        .find((candidate) => candidate.url().includes('window=main'));
      await page
        ?.evaluate((settings) => window.fumu.updateGeneralSettings(settings), startupRestore)
        .catch(() => undefined);
    }
    const child = application.process();
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
    // PlaywrightのElectron終了APIはapp.quit()に加えて、テスト用に注入した
    // Node inspector接続も閉じる。app.quit()だけをevaluateすると、そのMessagePortが
    // 製品コードには存在しない残存handleとなり、WindowsでE2Eプロセスだけが残る。
    void application.close().catch(() => undefined);
    automationProcessClosed = await Promise.race([
      exited.then(() => true),
      new Promise((resolveWait) => setTimeout(() => resolveWait(false), 4_000)),
    ]);
    if (!automationProcessClosed) {
      const processSnapshot = spawnSync(
        'pwsh.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${String(child.pid)} -or $_.ParentProcessId -eq ${String(child.pid)} } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      process.stderr.write(`${processSnapshot.stdout.trim()}\n`);
      const log = await readFile(join(userData, 'logs', 'main.log'), 'utf8').catch(() => '');
      process.stderr.write(`[logs\\main.log]\n${log.slice(-8_192)}\n`);
      await terminateProcessTree(child);
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
      failure ??= new Error('Playwright-instrumented Fumu did not close after cleanup.');
    }
    if (failure === null && result !== null) {
      const autostartHidden = await verifyPackagedAutostartHidden();
      result = { ...result, autostartHidden };
    }
    // The automation process contains Playwright's --inspect transport. Verify
    // product shutdown separately without that injected MessagePort, using the
    // same persisted settings and profile created by this scenario.
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    gracefulQuit = await verifyPlainProductShutdown();
  }
  provider.kill('SIGKILL');
  // WindowsのChromium補助DBはprocess終了直後も短時間lockされることがある。
  // E2E本体の失敗理由をcleanupで上書きしない。
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  if (!gracefulQuit && failure === null) {
    failure = new Error('Fumu did not quit gracefully.');
  }
  let evidencePath = null;
  try {
    evidencePath = await evidence.write({
      status: failure === null ? 'passed' : 'failed',
      result: { ...result, gracefulQuit, automationProcessClosed },
      error: failure,
      screenshots,
    });
  } catch (evidenceError) {
    failure ??= evidenceError;
  }
  if (failure !== null) {
    console.error(failure);
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify({ ...result, gracefulQuit, automationProcessClosed, evidencePath })}\n`,
  );
  // Playwright/Electronが保持するdebug pipeはWindowsでexit event後もしばらく残る。
  // 検証とcleanupが完了した時点でutility processを確実に終える。
  process.exit(0);
}
