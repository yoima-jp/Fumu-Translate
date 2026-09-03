import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Release integrity hashes all installed dependency bytes immediately after
    // npm ci. Vitest's default results cache lives under node_modules and mutates
    // after the test gate, so disable it instead of excluding a writable subtree.
    cache: false,
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
