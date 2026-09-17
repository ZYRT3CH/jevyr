import { defineConfig } from 'vitest/config';

// The causal read model is intentionally independent of the Vinext/Cloudflare
// renderer runtime, so its tests use a plain Node environment and no UI plugins.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
