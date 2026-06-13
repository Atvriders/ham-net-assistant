import { defineConfig } from 'vitest/config';

// API tests are integration-style: each makeTestApp() runs `prisma migrate
// deploy` against a fresh SQLite file and argon2-hashes passwords. On slower
// CI runners (e.g. the self-hosted Gitea act_runner) the default 5s timeout
// is too tight — a single test that does several awaited API round-trips can
// legitimately take longer. Raise the per-test and per-hook ceilings.
//
// Serialize file-level execution (singleFork + fileParallelism:false) so the
// better-sqlite3 / Prisma native-handle teardown races don't pile up across
// parallel workers — that race produced a SIGABRT (exit 134) on Node 22 in
// CI run 347 AFTER all assertions had already passed. teardownTimeout gives
// each file's afterAll() room to $disconnect() Prisma cleanly.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    teardownTimeout: 15000,
  },
});
