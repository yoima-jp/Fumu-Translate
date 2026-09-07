import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, rmdir } from 'node:fs/promises';
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

export function installationScript(
  installer: string,
  parentPid: number,
  executable: string,
): string {
  // 親の通常終了（DB・Workerの解放）を待つ。NSISの --force-run は
  // assisted installerでも /S と組み合わせるとインストール後にアプリを起動する。
  // 文字列はPowerShellの単一引用符で渡し、パス中の $ や ` を実行させない。
  return `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new()
$installerPath = ${quotePowerShell(installer)}
$previousExecutable = ${quotePowerShell(executable)}
Write-Output 'FUMU_UPDATE_READY'
try {
  $parentProcess = Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue
  if ($parentProcess) { if (-not $parentProcess.WaitForExit(120000)) { throw 'Application did not exit' } }
  $result = Start-Process -FilePath $installerPath -ArgumentList '/S', '--updated', '--force-run' -WindowStyle Hidden -Wait -PassThru
  if ($result.ExitCode -ne 0) { throw "Installer exited with $($result.ExitCode)" }
} catch {
  $_ | Out-String | Set-Content -LiteralPath ($installerPath + '.error.log') -Encoding utf8
  Start-Process -FilePath $previousExecutable -WindowStyle Hidden
} finally {
  Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}`;
}

export async function launchInstaller(installer: string, executable: string): Promise<void> {
  const command = Buffer.from(
    installationScript(installer, process.pid, executable),
    'utf16le',
  ).toString('base64');
  const environment = { ...process.env };
  // NSISが再起動するインストール版に、旧ポータブル版のパスを継承させない。
  for (const key of Object.keys(environment)) {
    if (key.startsWith('PORTABLE_EXECUTABLE_')) delete environment[key];
  }
  const child = spawn(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', command],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: environment },
  );
  await new Promise<void>((resolve, reject) => {
    // PowerShell自体の起動成功だけでは構文エラーや起動制限を検出できない。
    // 待機処理に入った合図を受け取ってから、呼び出し元がアプリを終了する。
    const timer = setTimeout(() => fail(new Error('Update helper did not become ready')), 10_000);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    child.once('error', fail);
    const onExit = (): void => fail(new Error('Update helper exited before becoming ready'));
    child.once('exit', onExit);
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes('FUMU_UPDATE_READY')) return;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.stdout!.destroy();
      resolve();
    });
  });
  child.unref();
}
