import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(repositoryRoot, 'package-lock.json');
const outputPath = join(repositoryRoot, 'THIRD_PARTY_NOTICES.md');
const checkOnly = process.argv.includes('--check');

function packageDirectory(lockEntryPath) {
  return join(repositoryRoot, ...lockEntryPath.split('/'));
}

function normalizedLicense(value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error('Package metadata does not contain a valid SPDX license expression.');
}

function repositoryUrl(metadata) {
  if (typeof metadata.homepage === 'string' && metadata.homepage.length > 0) {
    return metadata.homepage;
  }
  if (typeof metadata.repository === 'string') {
    return metadata.repository;
  }
  if (
    typeof metadata.repository === 'object' &&
    metadata.repository !== null &&
    typeof metadata.repository.url === 'string'
  ) {
    return metadata.repository.url;
  }
  return null;
}

async function existingLicenseFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function readLicenseDocuments(packageName, directory, license) {
  let sourceDirectory = directory;
  let files = await existingLicenseFiles(sourceDirectory);

  // KoffiのPlatform Binary PackageはLicense Fileを重複収録していない。
  // 親Packageが同一VersionのMIT本文を持つため、その本文をNoticeへ明示的に継承する。
  if (files.length === 0 && packageName.startsWith('@koromix/koffi-')) {
    sourceDirectory = join(repositoryRoot, 'node_modules', 'koffi');
    files = await existingLicenseFiles(sourceDirectory);
  }

  // AWS SDK v3 / Smithyの一部sub-packageはpackage metadataにApache-2.0を宣言するが、
  // archive内のLICENSEを省略する。同一配布suiteのcore本文を使い、license宣言が
  // 一致する場合だけ継承して誤った本文をNoticeへ載せない。
  if (files.length === 0 && /^@(aws-sdk|smithy)\//u.test(packageName)) {
    const scope = packageName.startsWith('@aws-sdk/') ? '@aws-sdk' : '@smithy';
    const candidate = join(repositoryRoot, 'node_modules', scope, 'core');
    const candidateMetadata = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
    if (normalizedLicense(candidateMetadata.license) === license) {
      sourceDirectory = candidate;
      files = await existingLicenseFiles(sourceDirectory);
    }
  }

  if (files.length === 0 && packageName === 'data-uri-to-buffer' && license === 'MIT') {
    sourceDirectory = join(repositoryRoot, 'tools', 'licenses');
    files = ['data-uri-to-buffer-LICENSE.txt'];
  }

  if (files.length === 0) {
    throw new Error(`${packageName} does not contain a license or notice file.`);
  }

  return Promise.all(
    files.map(async (file) => ({
      file,
      // Upstream license text occasionally contains line-end spaces. They carry no legal
      // meaning and would make the generated Markdown fail this repository's format gate.
      text: (await readFile(join(sourceDirectory, file), 'utf8'))
        .replace(/\r\n?/gu, '\n')
        .replace(/[ \t]+$/gmu, '')
        .trim(),
    })),
  );
}

async function collectPackages() {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== 'object') {
    throw new Error('A package-lock v3 file is required to generate notices.');
  }

  const selectedEntries = Object.entries(lock.packages).filter(
    ([entryPath, entry]) =>
      entryPath.startsWith('node_modules/') && entry?.dev !== true && entry?.link !== true,
  );

  // ElectronはBuild Dependencyだが、配布Runtimeそのものなので必ず収録する。
  selectedEntries.push(['node_modules/electron', lock.packages['node_modules/electron']]);

  const uniqueEntries = new Map(selectedEntries);
  const packages = [];
  for (const [entryPath] of uniqueEntries) {
    const directory = packageDirectory(entryPath);
    try {
      await access(join(directory, 'package.json'));
    } catch {
      // package-lockには他OS向けOptional Packageもある。現在のWindows配布環境へ
      // installされていないBinaryは配布されないためNotice対象から除外する。
      continue;
    }

    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') {
      throw new Error(`${entryPath} has invalid package metadata.`);
    }
    const license = normalizedLicense(metadata.license);
    packages.push({
      name: metadata.name,
      version: metadata.version,
      license,
      url: repositoryUrl(metadata),
      documents: await readLicenseDocuments(metadata.name, directory, license),
    });
  }

  packages.push({
    name: 'Lobe Icons Codex logo',
    version: '1.91.0',
    license: 'MIT',
    url: 'https://github.com/lobehub/lobe-icons',
    documents: [
      {
        file: 'lobe-icons-LICENSE.txt',
        text: (
          await readFile(
            join(repositoryRoot, 'tools', 'licenses', 'lobe-icons-LICENSE.txt'),
            'utf8',
          )
        )
          .replace(/\r\n?/gu, '\n')
          .trim(),
      },
    ],
  });

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function render(packages) {
  const lines = [
    '# Fumu! Third-party notices',
    '',
    'This file is generated from `package-lock.json` and the installed Windows dependency tree.',
    'Do not edit it manually; run `npm run licenses` after changing dependencies.',
    '',
    'Electron Builder also places `LICENSE.electron.txt` and `LICENSES.chromium.html` next to the packaged executable. Those files cover Electron, Chromium, Node.js, and their bundled third-party components.',
    '',
  ];

  for (const dependency of packages) {
    lines.push(`## ${dependency.name} ${dependency.version}`);
    lines.push('');
    lines.push(`License: ${dependency.license}`);
    if (dependency.url !== null) {
      lines.push(`Source: ${dependency.url}`);
    }
    for (const document of dependency.documents) {
      lines.push('');
      lines.push(`### ${document.file}`);
      lines.push('');
      lines.push('```text');
      lines.push(document.text);
      lines.push('```');
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

async function main() {
  const output = render(await collectPackages());
  if (checkOnly) {
    const existing = await readFile(outputPath, 'utf8').catch(() => null);
    // Git for Windows may check text files out with CRLF even though this generator
    // deliberately emits LF. Compare normalized content so CI checks substance,
    // not the runner's checkout convention.
    if (existing === null || existing.replace(/\r\n?/gu, '\n') !== output) {
      throw new Error('THIRD_PARTY_NOTICES.md is stale. Run npm run licenses.');
    }
    return;
  }
  await writeFile(outputPath, output, 'utf8');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
