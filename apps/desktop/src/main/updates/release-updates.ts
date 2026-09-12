import { z } from 'zod';
import type { UpdateAsset } from './install-update';
import type { UpdateStatus } from '../../shared/update-contracts';

const repositoryUrl = 'https://github.com/yoima-jp/Fumu-Translate';
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
      size: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024 * 1024),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    }),
  ),
});

// 配布タグは vMAJOR.MINOR.PATCH。文字列比較では 1.10.0 を 1.9.0 より
// 古いと判定してしまうため、各桁を数値で比較する。未知の形式は更新しない。
function versionParts(value: string): bigint[] {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Unsupported release version');
  }
  return value.replace(/^v/, '').split('.').map(BigInt);
}

export function selectRelease(
  input: unknown,
  currentVersion: string,
  architecture: string,
  portable: boolean,
): { status: UpdateStatus; downloadUrl?: string; asset?: UpdateAsset } {
  const release = releaseSchema.parse(input);
  if (release.draft || release.prerelease) return { status: { phase: 'unavailable' } };
  const latest = versionParts(release.tag_name);
  const current = versionParts(currentVersion);
  const difference = latest.findIndex((part, index) => part !== current[index]);
  if (difference === -1 || latest[difference]! < current[difference]!) {
    return { status: { phase: 'current' } };
  }
  const version = release.tag_name.replace(/^v/, '');
  const filename = `Fumu-Setup-${version}-${architecture}.exe`;
  const expectedUrl = `${repositoryUrl}/releases/download/${release.tag_name}/${filename}`;
  const asset = release.assets.find(
    (candidate) => candidate.name === filename && candidate.browser_download_url === expectedUrl,
  );
  // RendererからURLを受け取らず、確認した公式リリースの配布物だけを開く。
  if (!asset) return { status: { phase: 'unavailable' } };
  return {
    status: { phase: 'available', version, portable },
    downloadUrl: expectedUrl,
    asset: { url: expectedUrl, size: asset.size, sha256: asset.digest.slice(7) },
  };
}

export class ReleaseUpdates {
  private asset: UpdateAsset | undefined;
  private installing: Promise<boolean> | undefined;
  private pending: Promise<UpdateStatus> | undefined;
  private cached: UpdateStatus | undefined;
  private checkedAt = 0;

  constructor(
    private readonly options: {
      version: string;
      architecture: string;
      portable: boolean;
      fetch: typeof fetch;
      install: (asset: UpdateAsset) => Promise<void>;
      warn: (message: string, error: unknown) => void;
    },
  ) {}

  check(): Promise<UpdateStatus> {
    if (this.pending) return this.pending;
    // 設定の開き直しや連打でGitHubの匿名API制限を消費しない。
    if (this.cached && Date.now() - this.checkedAt < 60_000) return Promise.resolve(this.cached);
    this.pending = this.fetchRelease().then((status) => {
      this.cached = status;
      this.checkedAt = Date.now();
      this.pending = undefined;
      return status;
    });
    return this.pending;
  }

  private async fetchRelease(): Promise<UpdateStatus> {
    this.asset = undefined;
    try {
      const response = await this.options.fetch(
        'https://api.github.com/repos/yoima-jp/Fumu/releases/latest',
        {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status === 404) return { phase: 'unavailable' };
      if (!response.ok) throw new Error(`Release request failed: ${response.status}`);
      const result = selectRelease(
        await response.json(),
        this.options.version,
        this.options.architecture,
        this.options.portable,
      );
      this.asset = result.asset;
      return result.status;
    } catch (error) {
      this.options.warn('Failed to check for updates', error);
      return { phase: 'error' };
    }
  }

  download(): Promise<boolean> {
    if (this.installing) return this.installing;
    const asset = this.asset;
    if (!asset) return Promise.resolve(false);
    this.installing = this.options
      .install(asset)
      .then(() => true)
      .catch((error: unknown) => {
        this.options.warn('Failed to install update', error);
        return false;
      })
      .finally(() => {
        this.installing = undefined;
      });
    return this.installing;
  }
}
