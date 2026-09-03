import { pathToFileURL } from 'node:url';

export type RendererKind = 'main' | 'popup';
export type RendererEntryUrls = Readonly<Record<RendererKind, string>>;

const DEVELOPMENT_RENDERER_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Packaged builds must never let process environment redefine the renderer trust root.
 * In development, electron-vite still needs a URL, but only an explicit loopback HTTP
 * endpoint is accepted so a copied shell environment cannot expose the preload bridge
 * to an arbitrary network origin.
 */
export function trustedRendererUrl(
  isPackaged: boolean,
  configuredUrl: string | undefined,
): string | undefined {
  if (isPackaged) {
    return undefined;
  }
  const value = configuredUrl?.trim();
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !DEVELOPMENT_RENDERER_HOSTS.has(url.hostname) ||
    url.port.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error('Development renderer URL must be loopback HTTP with an explicit port.');
  }
  return url.toString();
}

function withWindowKind(url: URL, kind: RendererKind): string {
  url.searchParams.set('window', kind);
  return url.toString();
}

/** Mirrors BrowserWindow.loadURL/loadFile construction and yields exact entry URLs. */
export function rendererEntryUrls(
  developmentRendererUrl: string | undefined,
  bundledHtmlPath: string,
): RendererEntryUrls {
  const entry =
    developmentRendererUrl === undefined
      ? pathToFileURL(bundledHtmlPath)
      : new URL(developmentRendererUrl);
  return {
    main: withWindowKind(new URL(entry), 'main'),
    popup: withWindowKind(new URL(entry), 'popup'),
  };
}

export function classifyRendererUrl(
  senderUrl: string,
  expected: RendererEntryUrls,
): RendererKind | null {
  if (senderUrl === expected.main) return 'main';
  if (senderUrl === expected.popup) return 'popup';
  return null;
}

export function assertRendererAccess(
  senderUrl: string,
  isMainFrame: boolean,
  expected: RendererEntryUrls,
  allowedKinds: readonly RendererKind[],
): RendererKind {
  if (!isMainFrame) {
    throw new Error('Rejected IPC from a non-main frame.');
  }
  const kind = classifyRendererUrl(senderUrl, expected);
  if (kind === null || !allowedKinds.includes(kind)) {
    throw new Error('Rejected IPC from an untrusted renderer.');
  }
  return kind;
}
