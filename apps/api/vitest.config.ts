import { defineConfig } from 'vitest/config';

// API tests are integration-style: each makeTestApp() runs `prisma migrate
// deploy` against a fresh SQLite file and argon2-hashes passwords. On slower
// CI runners (e.g. the self-hosted Gitea act_runner) the default 5s timeout
// is too tight — a single test that does several awaited API round-trips can
// legitimately take longer. Raise the per-test and per-hook ceilings.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
