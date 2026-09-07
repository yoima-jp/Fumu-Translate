import { describe, expect, it, vi } from 'vitest';
import { ReleaseUpdates, selectRelease } from './release-updates';

function release(version = '1.10.0', portable = false) {
  const name = `Fumu-${portable ? 'Portable' : 'Setup'}-${version}-x64.exe`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name,
        size: 123,
        digest: 'sha256:' + 'a'.repeat(64),
        browser_download_url: `https://github.com/yoima-jp/Fumu/releases/download/v${version}/${name}`,
      },
    ],
  };
}

describe('release selection', () => {
  it('compares versions numerically and never downgrades', () => {
    expect(selectRelease(release(), '1.9.0', 'x64', false).status.phase).toBe('available');
    expect(selectRelease(release(), '1.10.0', 'x64', false).status.phase).toBe('current');
    expect(selectRelease(release(), '2.0.0', 'x64', false).status.phase).toBe('current');
  });
  it('requires the correct architecture and distribution', () => {
    expect(selectRelease(release(), '1.0.0', 'arm64', false).status.phase).toBe('unavailable');
    expect(selectRelease(release(), '1.0.0', 'x64', true).status).toMatchObject({
      phase: 'available',
      portable: true,
    });
    expect(selectRelease(release(), '1.0.0', 'x64', true).downloadUrl).toContain('Setup');
  });
  it('rejects drafts, prereleases, malformed versions and foreign URLs', () => {
    for (const flag of ['draft', 'prerelease']) {
      expect(
        selectRelease({ ...release(), [flag]: true }, '1.0.0', 'x64', false).status.phase,
      ).toBe('unavailable');
    }
    expect(() => selectRelease(release('bad'), '1.0.0', 'x64', false)).toThrow();
    const input = release();
    input.assets[0]!.browser_download_url = 'https://example.com/setup.exe';
    expect(selectRelease(input, '1.0.0', 'x64', false).downloadUrl).toBeUndefined();
  });
});

describe('release service', () => {
  function service(fetcher: typeof fetch) {
    const install = vi.fn(async () => {});
    const warn = vi.fn();
    return {
      updates: new ReleaseUpdates({
        version: '1.0.0',
        architecture: 'x64',
        portable: false,
        fetch: fetcher,
        install,
        warn,
      }),
      install,
      warn,
    };
  }
  it('deduplicates checks and only opens the verified download', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(release())));
    const { updates, install } = service(fetcher);
    expect(await updates.download()).toBe(false);
    const checks = await Promise.all([updates.check(), updates.check()]);
    expect(checks[0]?.phase).toBe('available');
    await updates.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await updates.download()).toBe(true);
    expect(install).toHaveBeenCalledWith({
      url: release().assets[0]!.browser_download_url,
      size: 123,
      sha256: 'a'.repeat(64),
    });
  });
  it('handles missing releases, API failures and network errors', async () => {
    for (const code of [404, 403, 500]) {
      const { updates } = service(
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: code })),
      );
      expect((await updates.check()).phase).toBe(code === 404 ? 'unavailable' : 'error');
      expect(await updates.download()).toBe(false);
    }
    const { updates, warn } = service(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
    );
    expect((await updates.check()).phase).toBe('error');
    expect(warn).toHaveBeenCalledOnce();
  });
  it('reports installer launch failures and permits retry', async () => {
    const { updates, install } = service(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(release()))),
    );
    await updates.check();
    install.mockRejectedValueOnce(new Error('installer unavailable'));
    expect(await updates.download()).toBe(false);
    expect(await updates.download()).toBe(true);
  });
  it('deduplicates simultaneous installation requests', async () => {
    const { updates, install } = service(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(release()))),
    );
    await updates.check();
    expect(await Promise.all([updates.download(), updates.download()])).toEqual([true, true]);
    expect(install).toHaveBeenCalledOnce();
  });
});
