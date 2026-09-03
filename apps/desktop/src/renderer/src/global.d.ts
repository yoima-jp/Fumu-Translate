import type { FumuDesktopApi } from '../../shared/contracts';

declare global {
  interface Window {
    readonly fumu: FumuDesktopApi;
  }
}

export {};
