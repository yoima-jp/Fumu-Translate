import { createHash } from 'node:crypto';
import { access, mkdtemp, open, rm, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export interface UpdateAsset {
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export async function downloadInstaller(
  asset: UpdateAsset,
  directory: string,
  fetcher: typeof fetch,
): Promise<string> {
  const folder = await mkdtemp(join(directory, 'fumu-update-'));
  const destination = join(folder, 'Fumu-Setup.exe');
  try {
    const response = await fetcher(asset.url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body)
      throw new Error(`Update download failed: ${response.status}`);
    const file = await open(destination, 'wx');
    const hash = createHash('sha256');
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > asset.size) throw new Error('Update exceeds expected size');
        hash.update(chunk);
        // FileHandle.write can write fewer bytes than requested.
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await file.write(chunk, offset, chunk.byteLength - offset);
          if (result.bytesWritten === 0) throw new Error('Update write stalled');
          offset += result.bytesWritten;
        }
      }
    } finally {
      await file.close();
    }
    if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
      throw new Error('Update integrity verification failed');
    }
    return destination;
  } catch (error) {
    await rm(destination, { force: true });
    await rmdir(folder);
    throw error;
  }
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function readyMarkerPath(installer: string): string {
  return `${installer}.ready`;
}

export function installationScript(
  installer: string,
  parentPid: number,
  executable: string,
): string {
  // 親の通常終了（DB・Workerの解放）を待つ。NSISの --force-run は
  // assisted installerでも /S と組み合わせるとインストール後にアプリを起動する。
  // 文字列はPowerShellの単一引用符で渡し、パス中の $ や ` を実行させない。
  // Start-Process -Wait は Windows PowerShell 5.1 だと子孫プロセスの終了まで待つため、
  // インストーラー本体だけを WaitForExit で待つ。Handle を先に参照しておかないと
  // 終了後に ExitCode が取得できない。
  return `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new()
$installerPath = ${quotePowerShell(installer)}
$readyMarker = ${quotePowerShell(readyMarkerPath(installer))}
$previousExecutable = ${quotePowerShell(executable)}
[System.IO.File]::WriteAllText($readyMarker, '')
try {
  $parentProcess = Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue
  if ($parentProcess) { if (-not $parentProcess.WaitForExit(120000)) { throw 'Application did not exit' } }
  $installerProcess = Start-Process -FilePath $installerPath -ArgumentList '/S', '--updated', '--force-run' -WindowStyle Hidden -PassThru
  $null = $installerProcess.Handle
  $installerProcess.WaitForExit()
  if ($installerProcess.ExitCode -ne 0) { throw "Installer exited with $($installerProcess.ExitCode)" }
} catch {
  $_ | Out-String | Set-Content -LiteralPath ($installerPath + '.error.log') -Encoding utf8
  Start-Process -FilePath $previousExecutable -WindowStyle Hidden
} finally {
  Remove-Item -LiteralPath $installerPath, $readyMarker -Force -ErrorAction SilentlyContinue
}`;
}

export function launcherScript(helperScript: string): string {
  return `$ErrorActionPreference = 'Stop'
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList '-NoProfile', '-NonInteractive', '-EncodedCommand', '${encodePowerShell(helperScript)}'`;
}

export async function launchInstaller(installer: string, executable: string): Promise<void> {
  const environment = { ...process.env };
  // NSISが再起動するインストール版に、旧ポータブル版のパスを継承させない。
  for (const key of Object.keys(environment)) {
    if (key.startsWith('PORTABLE_EXECUTABLE_')) delete environment[key];
  }
  await startPowerShellHelper(
    installationScript(installer, process.pid, executable),
    readyMarkerPath(installer),
    environment,
  );
}

export async function startPowerShellHelper(
  script: string,
  readyMarker: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<void> {
  // 補助PowerShellはアプリ終了後も生き残る必要があるが、二段で起動する理由は次のとおり。
  // - spawn の detached: true は DETACHED_PROCESS（コンソールなし）で起動し、
  //   Windows PowerShell 5.1 はその状態だとスクリプトを一切実行せず終了コード 0 で終わる。
  //   この不具合で更新がダウンロード後に必ず失敗していたため、detached に戻さないこと。
  // - detached なしの子は libuv が KILL_ON_JOB_CLOSE のジョブに入れるため、親の終了と同時に
  //   強制終了される。ただしそのジョブは SILENT_BREAKAWAY_OK なので、子が Start-Process で
  //   起動した孫はジョブ外になり、アプリ終了後も処理を続けられる。
  // 孫の標準出力は受け取れないので、待機処理に入った合図はマーカーファイルで受け取る。
  // PowerShell の起動成功だけでは構文エラーや起動制限を検出できないため、合図を確認してから
  // 呼び出し元がアプリを終了する。
  const launcher = spawn(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(launcherScript(script))],
    { stdio: 'ignore', windowsHide: true, env: environment },
  );
  let launchFailure: Error | undefined;
  launcher.once('error', (error) => {
    launchFailure = error;
  });
  launcher.once('exit', (code) => {
    if (code !== 0) launchFailure ??= new Error(`Update launcher exited with ${code}`);
  });
  // PowerShell の初回起動はモジュール準備で数秒かかることがあるため余裕を持たせる。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launchFailure) throw launchFailure;
    try {
      await access(readyMarker);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error('Update helper did not become ready');
}
