import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { artifactTree } from './artifact-tree.mjs';

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', rejectHash);
    stream.once('end', resolveHash);
  });
  return hash.digest('hex').toUpperCase();
}

async function artifact(root, path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return {
      path: relative(root, path).replaceAll('\\', '/'),
      absolutePath: path,
      size: info.size,
      sha256: await sha256(path),
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function createE2eEvidenceContext({ root, kind, packagedExecutable }) {
  const mode = packagedExecutable === null ? 'development' : 'packaged';
  const generatedAt = new Date().toISOString();
  const runId = `${generatedAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
  const evidenceRoot = resolve(
    root,
    process.env.FUMU_E2E_EVIDENCE_DIR?.trim() || 'artifacts/e2e-evidence',
  );
  const runDirectory = join(evidenceRoot, `${kind}-${mode}-${runId}`);
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(runDirectory, { recursive: false });

  const executable =
    packagedExecutable === null
      ? resolve(root, 'node_modules/electron/dist/electron.exe')
      : resolve(root, packagedExecutable);
  const resources = packagedExecutable === null ? null : join(dirname(executable), 'resources');
  const asar = resources === null ? null : join(resources, 'app.asar');
  const unpacked = resources === null ? null : join(resources, 'app.asar.unpacked');
  const nativeAddon =
    resources === null
      ? resolve(root, 'node_modules/selection-hook/build/Release/selection-hook.node')
      : join(
          resources,
          'app.asar.unpacked/node_modules/selection-hook/build/Release/selection-hook.node',
        );
  const mainBundle = resources === null ? resolve(root, 'apps/desktop/out/main/index.js') : asar;

  return {
    mode,
    runDirectory,
    screenshotPath(name) {
      return join(runDirectory, name);
    },
    async write({ status, result, error = null, screenshots = [] }) {
      const manifest = {
        schemaVersion: 2,
        runId,
        generatedAt,
        kind,
        mode,
        status,
        binaries: {
          executable: await artifact(root, executable),
          asar: asar === null ? null : await artifact(root, asar),
          mainBundle: await artifact(root, mainBundle),
          nativeAddon: await artifact(root, nativeAddon),
          unpackedTree: unpacked === null ? null : await artifactTree(root, unpacked),
        },
        screenshots: await Promise.all(screenshots.map(async (path) => artifact(root, path))),
        result,
        error:
          error === null
            ? null
            : {
                name: error instanceof Error ? error.name : 'UnknownError',
                message: error instanceof Error ? error.message : String(error),
              },
      };
      const manifestPath = join(runDirectory, 'evidence.json');
      // `wx` makes accidental reuse a hard failure rather than silently replacing evidence.
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return manifestPath;
    },
  };
}
