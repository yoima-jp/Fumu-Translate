import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import * as koffi from 'koffi';
import { createE2eEvidenceContext } from './e2e-evidence.mjs';

if (process.platform !== 'win32') {
  throw new Error('The native selection E2E requires Windows.');
}

const root = resolve(import.meta.dirname, '..');
const packagedExecutable = process.env.FUMU_E2E_EXECUTABLE?.trim() || null;
const evidence = await createE2eEvidenceContext({
  root,
  kind: 'native-selection',
  packagedExecutable,
});
const userData = await mkdtemp(join(tmpdir(), 'fumu-native-selection-'));
const providerPort = '43123';
const windowTitle = `Fumu Selection Fixture ${Date.now()}`;
const selectedText = `Foreground selection ${Date.now()} — 日本語`;
const privateValue = `private-${Date.now()}`;
const concurrentOriginalValue = `original-${Date.now()}`;
const concurrentExternalValue = `external-${Date.now()}`;
const provider = spawn(process.execPath, ['tools/mock-openai-provider.mjs'], {
  cwd: root,
  env: { ...process.env, FUMU_MOCK_PROVIDER_PORT: providerPort },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const fixture = spawn(
  'pwsh.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'tools/windows/caret-fixture.ps1',
    '-WindowTitle',
    windowTitle,
    '-Text',
    selectedText,
    '-SelectAll',
  ],
  { cwd: root, stdio: 'ignore', windowsHide: true },
);

const user32 = koffi.load('user32.dll');
const findWindow = user32.func('__stdcall', 'FindWindowW', 'void *', ['str16', 'str16']);
const showWindow = user32.func('__stdcall', 'ShowWindow', 'bool', ['void *', 'int32']);
const setForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['void *']);
const switchToThisWindow = user32.func('__stdcall', 'SwitchToThisWindow', 'void', [
  'void *',
  'bool',
]);
const setCursorPos = user32.func('__stdcall', 'SetCursorPos', 'bool', ['int32', 'int32']);
const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', [
  'uint8',
  'uint8',
  'uint32',
  'uintptr_t',
]);

const KEY_UP = 0x0002;
const VK_CONTROL = 0x11;
const VK_SHIFT = 0x10;
const VK_MENU = 0x12;
const VK_J = 0x4a;
const VK_RIGHT = 0x27;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function validHandle(handle) {
  return handle !== null && handle !== undefined && handle !== 0 && handle !== 0n;
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

async function waitForFixture(title = windowTitle) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const handle = findWindow(null, title);
    if (validHandle(handle)) return handle;
    await delay(50);
  }
  throw new Error('Win32 selection fixture was not created.');
}

async function waitForWindow(application, kind) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = application
      .windows()
      .find((candidate) => candidate.url().includes(`window=${kind}`));
    if (page) return page;
    await delay(50);
  }
  throw new Error(`${kind} window was not created.`);
}

async function waitForNativeStatus(page) {
  const deadline = Date.now() + 10_000;
  let status = null;
  while (Date.now() < deadline) {
    status = await page.evaluate(() => window.fumu.getStatus());
    if (status.selectionServiceRunning && status.hotkeyState === 'registered') return status;
    await delay(50);
  }
  throw new Error(`Native integration was not ready: ${JSON.stringify(status)}`);
}

async function waitForCompletedTranslation(page) {
  await page
    .locator('[data-testid="translation-card"][data-state="complete"]')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function focusFixture(handle) {
  showWindow(handle, 9);
  // An Alt press permits foreground activation under Windows' foreground-lock rules.
  keybdEvent(VK_MENU, 0, 0, 0);
  keybdEvent(VK_MENU, 0, KEY_UP, 0);
  setForegroundWindow(handle);
  switchToThisWindow(handle, true);
  await delay(150);
}

async function sendKey(key, modifiers = []) {
  for (const modifier of modifiers) keybdEvent(modifier, 0, 0, 0);
  keybdEvent(key, 0, 0, 0);
  keybdEvent(key, 0, KEY_UP, 0);
  for (const modifier of [...modifiers].reverse()) keybdEvent(modifier, 0, KEY_UP, 0);
  await delay(100);
}

function runClipboardFixture(mode, value = privateValue) {
  const result = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'tools/windows/private-clipboard-fixture.ps1',
      '-Mode',
      mode,
      '-Value',
      value,
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Private clipboard ${mode} failed.`);
  }
  return result.stdout.trim();
}

function selectionProcessSnapshot(rootProcessId) {
  const script = [
    '$all = @(Get-CimInstance Win32_Process)',
    `$root = ${String(rootProcessId)}`,
    '$ids = [Collections.Generic.HashSet[int]]::new()',
    '[void]$ids.Add($root)',
    'do {',
    '  $added = $false',
    '  foreach ($process in $all) {',
    '    if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $added = $true }',
    '  }',
    '} while ($added)',
    "$matches = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.CommandLine -like '*selection-process.js*' } | Select-Object ProcessId,ParentProcessId,CommandLine)",
    'ConvertTo-Json -Compress -InputObject $matches',
  ].join('; ');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Selection process snapshot failed.');
  }
  const parsed = JSON.parse(result.stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function waitForSelectionProcessReplacement(rootProcessId, previousProcessId) {
  const deadline = Date.now() + 12_000;
  let snapshot = [];
  while (Date.now() < deadline) {
    snapshot = selectionProcessSnapshot(rootProcessId);
    if (snapshot.length === 1 && Number(snapshot[0]?.ProcessId) !== Number(previousProcessId)) {
      return snapshot[0];
    }
    await delay(100);
  }
  throw new Error(`Hung selection process was not replaced cleanly: ${JSON.stringify(snapshot)}`);
}

async function startConcurrentClipboardWriter(value) {
  const writer = spawn(
    'pwsh.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'tools/windows/concurrent-clipboard-writer.ps1',
      '-Value',
      value,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error('Clipboard writer startup timed out.')),
      5_000,
    );
    writer.once('error', rejectReady);
    writer.once('exit', (code) =>
      rejectReady(new Error(`Clipboard writer exited early: ${String(code)}`)),
    );
    writer.stdout.on('data', (chunk) => {
      if (String(chunk).includes('clipboard-writer-ready')) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
  });
  return writer;
}

async function terminateProcessTree(child) {
  if (child.pid === undefined || child.exitCode !== null) return;
  await new Promise((resolveTerminate) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', resolveTerminate);
    killer.once('exit', resolveTerminate);
  });
}

let application;
let oversizedFixture = null;
let concurrentWriter = null;
let fixtureClipboardSet = false;
let failure = null;
let gracefulQuit = false;
let result = null;
try {
  const fixtureHandle = await waitForFixture(windowTitle);
  await waitForProvider();
  application = await electron.launch({
    ...(packagedExecutable === null
      ? {
          args: ['apps/desktop', `--user-data-dir=${userData}`, '--fumu-e2e-selection-hang'],
        }
      : {
          executablePath: resolve(root, packagedExecutable),
          args: [`--user-data-dir=${userData}`, '--fumu-e2e-selection-hang'],
        }),
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      FUMU_OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1/`,
      FUMU_OPENAI_MODEL: 'mock-model',
      FUMU_OPENAI_API_KEY: '',
      FUMU_E2E_SELECTION_HANG: '1',
    },
  });
  const main = await waitForWindow(application, 'main');
  const popup = await waitForWindow(application, 'popup');
  await waitForNativeStatus(main);

  // The first process deliberately blocks forever in a synchronous query. A
  // bounded UI fallback must appear, then Job Object retirement must leave one
  // fresh selection process and no wedged predecessor.
  const initialSelectionProcesses = selectionProcessSnapshot(application.process().pid);
  if (initialSelectionProcesses.length !== 1) {
    throw new Error(
      `Expected one initial selection process: ${JSON.stringify(initialSelectionProcesses)}`,
    );
  }
  runClipboardFixture('Clear');
  await focusFixture(fixtureHandle);
  setCursorPos(2, 2);
  await sendKey(VK_J, [VK_CONTROL, VK_SHIFT]);
  // Locale文言はプロダクト仕様として変更される。Native Selectionの回帰検証が
  // 翻訳文言の変更で停止しないよう、表示テキストではなく安定した識別子を使う。
  await popup.getByTestId('popup-source-input').waitFor({ state: 'visible', timeout: 5_000 });
  await popup.evaluate(() => window.fumu.closePopup());
  const replacementSelectionProcess = await waitForSelectionProcessReplacement(
    application.process().pid,
    initialSelectionProcesses[0].ProcessId,
  );
  await waitForNativeStatus(main);

  const methodPromise = popup.evaluate(
    () =>
      new Promise((resolveMethod, rejectMethod) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          rejectMethod(new Error('Selection method was not published.'));
        }, 10_000);
        const unsubscribe = window.fumu.onPopupState((state) => {
          if (state.phase === 'selection') {
            clearTimeout(timeout);
            unsubscribe();
            resolveMethod({
              method: state.selection.method,
              programName: state.selection.programName,
            });
          }
        });
      }),
  );
  await focusFixture(fixtureHandle);
  setCursorPos(2, 2);
  await sendKey(VK_J, [VK_CONTROL, VK_SHIFT]);
  await popup.getByText(selectedText, { exact: true }).waitFor({ timeout: 10_000 });
  await waitForCompletedTranslation(popup);
  const selectionIdentity = await methodPromise;
  const selectionMethod = selectionIdentity.method;
  if (selectionMethod !== 'uia' && selectionMethod !== 'accessible') {
    throw new Error(`Unexpected native selection method: ${String(selectionMethod)}`);
  }
  if (
    typeof selectionIdentity.programName !== 'string' ||
    !selectionIdentity.programName.toLowerCase().endsWith('pwsh.exe')
  ) {
    throw new Error(
      `Selection targeted a non-foreground process: ${String(selectionIdentity.programName)}`,
    );
  }

  // A malicious accessibility provider can expose a document-sized selection. The
  // native boundary must reject it without terminating or wedging the worker, and a
  // subsequent ordinary UIA query must still succeed.
  await popup.evaluate(() => window.fumu.closePopup());
  runClipboardFixture('Clear');
  const oversizedWindowTitle = `Fumu Oversized Selection ${Date.now()}`;
  oversizedFixture = spawn(
    'pwsh.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'tools/windows/caret-fixture.ps1',
      '-WindowTitle',
      oversizedWindowTitle,
      '-GeneratedTextLength',
      '200001',
      '-SelectAll',
    ],
    { cwd: root, stdio: 'ignore', windowsHide: true },
  );
  const oversizedFixtureHandle = await waitForFixture(oversizedWindowTitle);
  await focusFixture(oversizedFixtureHandle);
  setCursorPos(2, 2);
  await sendKey(VK_J, [VK_CONTROL, VK_SHIFT]);
  await popup.getByTestId('popup-source-input').waitFor({ state: 'visible', timeout: 10_000 });
  if (application.process().exitCode !== null) {
    throw new Error('Fumu exited while rejecting an oversized UIA selection.');
  }
  await terminateProcessTree(oversizedFixture);
  oversizedFixture = null;

  await popup.evaluate(() => window.fumu.closePopup());
  await focusFixture(fixtureHandle);
  await sendKey(VK_J, [VK_CONTROL, VK_SHIFT]);
  await popup.getByText(selectedText, { exact: true }).waitFor({ timeout: 10_000 });
  await waitForCompletedTranslation(popup);

  // An external writer that updates Clipboard after Fumu's temporary clear is
  // newer user data. It must survive the transaction instead of being replaced
  // by Fumu's old backup.
  await popup.evaluate(() => window.fumu.closePopup());
  await focusFixture(fixtureHandle);
  await sendKey(VK_RIGHT);
  runClipboardFixture('SetText', concurrentOriginalValue);
  fixtureClipboardSet = true;
  concurrentWriter = await startConcurrentClipboardWriter(concurrentExternalValue);
  await focusFixture(fixtureHandle);
  await sendKey(VK_J, [VK_CONTROL, VK_SHIFT]);
  await popup.getByText(concurrentExternalValue, { exact: true }).waitFor({ timeout: 10_000 });
  const writerExitCode =
    concurrentWriter.exitCode ??
    (await new Promise((resolveExit, rejectExit) => {
      concurrentWriter.once('error', rejectExit);
      concurrentWriter.once('exit', resolveExit);
    }));
  if (writerExitCode !== 0) {
    throw new Error(`Concurrent Clipboard writer failed: ${String(writerExitCode)}`);
  }
  concurrentWriter = null;
  runClipboardFixture('CheckText', concurrentExternalValue);
  runClipboardFixture('Clear');
  fixtureClipboardSet = false;

  await popup.evaluate(() => window.fumu.closePopup());
  await focusFixture(fixtureHandle);
  await sendKey(VK_RIGHT);
  runClipboardFixture('Set');
  fixtureClipboardSet = true;
  await focusFixture(fixtureHandle);
  await sendKey(VK_J, [VK_CONTROL, VK_SHIFT]);
  await popup.getByTestId('popup-source-input').waitFor({ state: 'visible', timeout: 10_000 });
  const clipboardCheck = runClipboardFixture('Check');

  runClipboardFixture('Clear');
  fixtureClipboardSet = false;
  const readNativeClipboard = () =>
    application.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const requireFromApp = createRequire(`${app.getAppPath()}/out/main/index.js`);
      const SelectionHook = requireFromApp('selection-hook');
      return new SelectionHook().readFromClipboard();
    });

  runClipboardFixture('SetMalformedUnicode');
  fixtureClipboardSet = true;
  const malformedClipboard = await readNativeClipboard();
  // Windows normalizes a standard CF_UNICODETEXT handle by reserving its final wchar
  // for NUL. Accept that OS-normalized bounded value, while still proving the native
  // reader remains alive and never returns data beyond the small source allocation.
  if (malformedClipboard !== null && malformedClipboard.length > 64) {
    throw new Error('Native clipboard reader returned data beyond the malformed HGLOBAL boundary.');
  }
  runClipboardFixture('Clear');
  fixtureClipboardSet = false;

  runClipboardFixture('SetOversizedUnicode');
  fixtureClipboardSet = true;
  const oversizedClipboard = await readNativeClipboard();
  if (oversizedClipboard !== null) {
    throw new Error('Native clipboard reader accepted an oversized Unicode HGLOBAL.');
  }
  runClipboardFixture('Clear');
  fixtureClipboardSet = false;

  result = {
    status: true,
    hotkey: true,
    foregroundSelection: true,
    selectionMethod,
    foregroundProgramName: selectionIdentity.programName,
    hungSelectionProcessReplaced: Number(replacementSelectionProcess.ProcessId) > 0,
    concurrentClipboardUpdatePreserved: true,
    privateClipboard: clipboardCheck,
    malformedClipboardSafelyHandled: true,
    oversizedClipboardRejected: true,
    oversizedUiaSelectionRejected: true,
    selectionWorkerRecoveredAfterOversizedUia: true,
  };
} catch (error) {
  failure = error;
} finally {
  if (fixtureClipboardSet) {
    try {
      runClipboardFixture('Clear');
    } catch {
      // Cleanup must not hide the primary E2E failure.
    }
  }
  if (application) {
    const child = application.process();
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
    // application.close()はapp.quit()だけでなく、Playwrightが挿入したNode
    // inspector接続も閉じる。直接evaluateすると製品にはないMessagePortが残る。
    void application.close().catch(() => undefined);
    gracefulQuit = await Promise.race([
      exited.then(() => true),
      new Promise((resolveWait) => setTimeout(resolveWait, 8_000, false)),
    ]);
    if (!gracefulQuit) {
      const electronState = await Promise.race([
        application
          .evaluate(({ app, BrowserWindow }) => ({
            ready: app.isReady(),
            windows: BrowserWindow.getAllWindows().length,
            quitting: true,
          }))
          .catch((error) => ({ evaluateError: String(error) })),
        new Promise((resolveState) =>
          setTimeout(() => resolveState({ evaluateError: 'diagnostic timeout' }), 1_000),
        ),
      ]);
      process.stderr.write(
        `${JSON.stringify({ gracefulQuit: false, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, electronState })}\n`,
      );
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
    }
  }
  await terminateProcessTree(fixture);
  if (oversizedFixture !== null) await terminateProcessTree(oversizedFixture);
  if (concurrentWriter !== null) await terminateProcessTree(concurrentWriter);
  await terminateProcessTree(provider);
  user32.unload();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}

if (!gracefulQuit && failure === null) failure = new Error('Fumu did not quit gracefully.');
let evidencePath = null;
try {
  evidencePath = await evidence.write({
    status: failure === null ? 'passed' : 'failed',
    result: { ...result, gracefulQuit },
    error: failure,
  });
} catch (evidenceError) {
  failure ??= evidenceError;
}
if (failure !== null) throw failure;
process.stdout.write(`${JSON.stringify({ ...result, gracefulQuit, evidencePath })}\n`);
