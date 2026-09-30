import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // Tests read recorded fixtures and never touch the network.
    globals: false,
  },
});
