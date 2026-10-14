import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadInstaller, installationScript, startPowerShellHelper } from './install-update';

const folders: string[] = [];
afterEach(async () => {
  // Only test-owned mkdtemp directories are removed.
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
async function directory(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'fumu-update-test-'));
  folders.push(folder);
  return folder;
}
const bytes = Buffer.from('test installer payload');
const asset = {
  url: 'https://github.com/yoima-jp/Fumu/releases/download/v2.0.0/Fumu-Setup-2.0.0-x64.exe',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

describe('installer download', () => {
  it.skipIf(process.platform !== 'win32')(
    'runs the helper with silent install and restart flags',
    async () => {
      const folder = await directory();
      await writeFile(join(folder, 'setup.exe'), 'test-only placeholder', 'utf8');
      // Start-Processをこの子PowerShell内だけで置き換え、実インストールは行わない。
      const mock = `function Start-Process { param($FilePath, $ArgumentList, $WindowStyle, [switch]$Wait, [switch]$PassThru)
      if ($ArgumentList -join ',' -ne '/S,--updated,--force-run') { throw 'Incorrect arguments' }
      if ($WindowStyle -ne 'Hidden') { throw 'Visible helper' }
      Write-Host 'INSTALLER_STARTED'
      $installer = [pscustomobject]@{ ExitCode = 0; Handle = 1 }
      $installer | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}
      return $installer
    }\n`;
      const script =
        mock + installationScript(join(folder, 'setup.exe'), 2147483647, join(folder, 'app.exe'));
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('INSTALLER_STARTED');
      expect(await readdir(folder)).toEqual([]);
    },
  );
  it('writes and verifies the complete file', async () => {
    const result = await downloadInstaller(
      asset,
      await directory(),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)),
    );
    expect(await readFile(result)).toEqual(bytes);
  });
  it('removes partial, oversized and corrupt files', async () => {
    for (const payload of [
      bytes.subarray(1),
      Buffer.concat([bytes, bytes]),
      Buffer.alloc(bytes.length),
    ]) {
      const folder = await directory();
      await expect(
        downloadInstaller(
          asset,
          folder,
          vi.fn<typeof fetch>().mockResolvedValue(new Response(payload)),
        ),
      ).rejects.toThrow();
      expect(await readdir(folder)).toEqual([]);
    }
  });
  it('handles HTTP errors and interrupted streams', async () => {
    for (const response of [
      new Response(null, { status: 503 }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('disconnected'));
          },
        }),
      ),
    ]) {
      const folder = await directory();
      await expect(
        downloadInstaller(asset, folder, vi.fn<typeof fetch>().mockResolvedValue(response)),
      ).rejects.toThrow();
      expect(await readdir(folder)).toEqual([]);
    }
  });
  it('quotes executable paths and waits for shutdown before silent installation', () => {
    const script = installationScript("C:\\test's $folder\\setup.exe", 123, 'C:\\Fumu!.exe');
    expect(script).toContain("'C:\\test''s $folder\\setup.exe'");
    expect(script.indexOf('WaitForExit(120000)')).toBeLessThan(
      script.indexOf("-ArgumentList '/S'"),
    );
    expect(script).toContain("'--updated', '--force-run'");
    expect(script).toContain('-WindowStyle Hidden');
  });
  it.skipIf(process.platform !== 'win32')(
    'runs the helper script outside the app process and signals readiness',
    async () => {
      // detached 起動だと Windows PowerShell 5.1 がスクリプトを実行しない不具合の回帰確認。
      const folder = await directory();
      const marker = join(folder, 'ready');
      const output = join(folder, 'output.txt');
      await startPowerShellHelper(
        `[System.IO.File]::WriteAllText('${marker}', '')
Set-Content -LiteralPath '${output}' -Value 'ran' -Encoding utf8`,
        marker,
        process.env,
      );
      await expect
        .poll(() => readFile(output, 'utf8').catch(() => ''), { timeout: 10_000 })
        .toContain('ran');
    },
    40_000,
  );
});
