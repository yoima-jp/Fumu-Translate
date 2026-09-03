import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      sourcemap: false,
      // Workspace packageはTS sourceをexportしているため、配布bundleへ取り込む。
      // ElectronのNode loaderへ残すと拡張子解決が環境依存になり、起動時に失敗する。
      externalizeDeps: {
        exclude: [
          '@fumu/agent-transport',
          '@fumu/http-sse',
          '@fumu/i18n',
          '@fumu/llm-core',
          '@fumu/provider-anthropic',
          '@fumu/provider-chatgpt',
          '@fumu/provider-google',
          '@fumu/provider-openai-compatible',
          '@fumu/translation-core',
        ],
      },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'agent-bootstrap': resolve(
            '../../packages/agent-transport/src/windows-agent-bootstrap.mjs',
          ),
          'selection-process': resolve('src/main/os/selection/selection-process.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
  },
  preload: {
    build: {
      sourcemap: false,
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      sourcemap: false,
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
  },
});
