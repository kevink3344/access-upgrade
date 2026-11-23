import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The suite talks to a real Azure SQL database, so give connection
    // setup and pooled queries room to finish.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One file at a time: the tests share a connection pool and a database.
    fileParallelism: false,
  },
});
