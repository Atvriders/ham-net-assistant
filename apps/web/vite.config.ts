// defineConfig comes from vitest/config (not vite) so the `test` block below
// is typed — vite 7's own UserConfig no longer carries it.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@themes': path.resolve(__dirname, '../../themes'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Raised from the 5s/1s defaults because Testing Library's *ByRole queries
    // walk the whole accessibility tree, and the net editor renders the full
    // IANA timezone list (~400 <option> nodes). That is fine in a browser but
    // slow in jsdom, and on a shared/throttled CI runner the default budget
    // produced intermittent failures in tests that were otherwise correct.
    // These are ceilings, not waits: passing tests still finish immediately.
    // (Testing Library's own findBy/waitFor budget is set alongside this in
    // src/test-setup.ts — vitest's testTimeout does not govern it.)
    testTimeout: 15000,
  },
});
