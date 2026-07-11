import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Specs run against devnet: several sequential transactions with
    // confirmation waits, so give each test plenty of room.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
