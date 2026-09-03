import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Hash every regular file in a runtime directory, including its relative path and size.
 * Symlinks are rejected because otherwise a packaged tree could resolve outside the
 * directory after evidence collection while retaining the same link record.
 */
export async function artifactTree(root, directory, options = {}) {
  const absoluteRoot = resolve(root);
  const absoluteDirectory = resolve(directory);
  const allowedLinks = new Map(
    Object.entries(options.allowedLinks ?? {}).map(([link, target]) => [
      link.replaceAll('\\', '/'),
      resolve(absoluteRoot, target),
    ]),
  );
  const seenLinks = new Set();
  let directoryInfo;
  try {
    directoryInfo = await lstat(absoluteDirectory);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!directoryInfo.isDirectory()) {
    throw new Error(`Artifact tree is not a directory: ${absoluteDirectory}`);
  }

  const files = [];
  const pendingFiles = [];
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const linkPath = relative(absoluteDirectory, path).replaceAll('\\', '/');
        const expectedTarget = allowedLinks.get(linkPath);
        if (expectedTarget === undefined) {
          throw new Error(`Artifact tree contains an unapproved symbolic link: ${path}`);
        }
        const actualTarget = resolve(await realpath(path));
        const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
        if (normalize(actualTarget) !== normalize(expectedTarget)) {
          throw new Error(`Artifact tree link target changed: ${path}`);
        }
        seenLinks.add(linkPath);
        const targetPath = relative(absoluteRoot, expectedTarget).replaceAll('\\', '/');
        files.push({
          kind: 'link',
          path: linkPath,
          size: 0,
          sha256: createHash('sha256')
            .update(`workspace-link\0${linkPath}\0${targetPath}`, 'utf8')
            .digest('hex')
            .toUpperCase(),
        });
        continue;
      }
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(`Artifact tree contains a non-regular entry: ${path}`);
      }
      pendingFiles.push({
        kind: 'file',
        path: relative(absoluteDirectory, path).replaceAll('\\', '/'),
        size: info.size,
        absolutePath: path,
      });
    }
  };
  await walk(absoluteDirectory);
  for (const linkPath of allowedLinks.keys()) {
    if (!seenLinks.has(linkPath)) {
      throw new Error(`Artifact tree is missing an expected workspace link: ${linkPath}`);
    }
  }
  // Opening thousands of small package files serially dominates release time on
  // Windows. A bounded worker set preserves deterministic output while keeping a
  // full byte-level dependency snapshot practical at every release boundary.
  let nextFile = 0;
  const hashedFiles = new Array(pendingFiles.length);
  const worker = async () => {
    while (nextFile < pendingFiles.length) {
      const index = nextFile;
      nextFile += 1;
      const pending = pendingFiles[index];
      const digest = await sha256(pending.absolutePath);
      const finalInfo = await lstat(pending.absolutePath);
      if (!finalInfo.isFile() || finalInfo.isSymbolicLink() || finalInfo.size !== pending.size) {
        throw new Error(`Artifact tree entry changed while hashing: ${pending.absolutePath}`);
      }
      hashedFiles[index] = {
        kind: pending.kind,
        path: pending.path,
        size: pending.size,
        sha256: digest,
      };
    }
  };
  const workerCount = Math.min(16, Math.max(1, pendingFiles.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  files.push(...hashedFiles);
  files.sort((left, right) => compareOrdinal(left.path, right.path));

  // NUL separators make the aggregate unambiguous even when a filename contains spaces
  // or newlines. Windows package paths cannot contain NUL.
  const aggregate = createHash('sha256');
  let totalSize = 0;
  for (const file of files) {
    aggregate.update(file.kind, 'ascii');
    aggregate.update('\0');
    aggregate.update(file.path, 'utf8');
    aggregate.update('\0');
    aggregate.update(String(file.size), 'utf8');
    aggregate.update('\0');
    aggregate.update(file.sha256, 'ascii');
    aggregate.update('\n');
    totalSize += file.size;
  }

  return {
    path: relative(absoluteRoot, absoluteDirectory).replaceAll('\\', '/'),
    absolutePath: absoluteDirectory,
    fileCount: files.length,
    totalSize,
    sha256: aggregate.digest('hex').toUpperCase(),
    files,
  };
}

async function runCli() {
  const argumentsByName = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('Usage: node tools/artifact-tree.mjs --root <path> --directory <path>');
    }
    argumentsByName.set(name.slice(2), value);
  }
  const root = argumentsByName.get('root');
  const directory = argumentsByName.get('directory');
  if (!root || !directory) {
    throw new Error('Both --root and --directory are required.');
  }
  process.stdout.write(`${JSON.stringify(await artifactTree(root, directory))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli();
}
