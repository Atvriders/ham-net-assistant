# Contributing to Ham-Net-Assistant

Thanks for working on this. The app runs live club nets — a broken deploy on a
Tuesday night means a net doesn't happen — so the bar is "green gate chain, or
it doesn't merge".

## 1. Prerequisites

| Thing | Version | Why |
|---|---|---|
| Node | **24** in CI and in the runtime image (`node:24-bookworm-slim`). Node 20 LTS also works locally today. | `@types/node` is pinned to ^24; match CI when a build behaves oddly. |
| npm | 10+ | The repo is npm **workspaces**; yarn/pnpm are not configured. |
| Build toolchain | `python3 make g++` on Linux | `argon2` is a native module and compiles on install. |

No Docker is required for development.

## 2. First-run setup (the sequence that actually works)

`npm install` alone is **not** enough: it neither builds `@hna/shared` (the API
and web both import it from `dist/`) nor generates the Prisma client, and
nothing in this repo loads a `.env` file into the server process.

```bash
npm install
npm -w @hna/shared run build          # writes packages/shared/dist — imports fail without it
npx -w @hna/api prisma generate       # writes node_modules/.prisma/client

# Create/upgrade the dev database. DATABASE_URL is required here: Prisma reads
# it from the environment, and apps/api/src/env.ts's default never reaches it.
DATABASE_URL="file:./dev.db" npm -w @hna/api run prisma:deploy
```

Then, in two terminals:

```bash
# terminal 1 — API on :3000. JWT_SECRET must be >= 32 chars and must not look
# like a placeholder ("change-me", "secret", "example", … are rejected by name).
export JWT_SECRET=$(openssl rand -hex 32)
DATABASE_URL="file:./dev.db" npm run dev:api

# terminal 2 — Vite on :5173, proxies /api -> :3000
npm run dev:web
```

Keep the same secret across restarts (write it into a file you `source`) or
every restart logs you out.

Open <http://localhost:5173>. The first account you register becomes ADMIN.

Rebuild `@hna/shared` whenever you change a schema in `packages/shared/src` —
the API and web consume its compiled output, not its sources.

> **`.env` is a trap here.** The API process has no dotenv dependency, so it
> reads only real environment variables. The Prisma CLI *does* read a `.env`
> from its working directory, so an `apps/api/.env` can make migrations work
> while the server still dies on boot. The repo-root `.env` is consumed by
> `docker compose` only. See `.env.example`.

## 3. The gate chain

Run this before you push. CI (`.github/workflows/ci.yml`) runs the same steps
in the same order and blocks the Docker publish job on them.

```bash
npm run typecheck                                  # 1. tsc --noEmit, all three workspaces
npx eslint . --max-warnings=0                      # 2. zero warnings, not just zero errors
npm test                                           # 3. shared + api + web suites
npm run build                                      # 4. shared tsc -> api tsc -> vite build
```

Notes:

- Single workspaces run standalone — `npm -w @hna/api run test`,
  `npm -w @hna/web run test` — because `apps/api/test/helpers.ts` sets a
  policy-compliant `JWT_SECRET` before anything imports `src/env.ts`.
- `--max-warnings=0` is deliberate. Don't silence a rule with an inline
  `eslint-disable` unless you also write the sentence explaining why the rule
  is wrong *here*; the two disabled `react-hooks` rules in
  `eslint.config.mjs` are the model for that.
- Prettier config (`.prettierrc.json`: single quotes, semicolons, trailing
  commas, 100 cols) describes the house style; `eslint-config-prettier` keeps
  ESLint out of formatting's way. Match the file you're editing.

## 4. Tests

Every behavior change needs a test. Follow the idiom already in the tree
instead of inventing a new one.

**API — `apps/api/test/**` (Vitest + Supertest, real SQLite).**
`makeTestApp()` from `test/helpers.js` creates a throwaway `test-*.db`, runs
`prisma migrate deploy` against it, and returns `{ app, prisma, dbFile }`.
Auth is a real cookie: register a user, keep `res.headers['set-cookie'][0]`,
and pass it as `.set('Cookie', officer)`. Always `cleanupTestDb(prisma, dbFile)`
in `afterAll` — it deletes the DB plus its `-wal`/`-shm` sidecars. Files run
serially on purpose (`maxWorkers: 1`, `fileParallelism: false`) because
parallel better-sqlite3 teardown aborted CI.

**Web — `apps/web/src/**/*.test.tsx` (Vitest + React Testing Library + jsdom).**
`src/test-setup.ts` wires `@testing-library/jest-dom` and the geometry shims
TipTap needs. Stub the network with `vi.stubGlobal('fetch', …)`; assert on
user-visible text or `data-testid`, not implementation details.

**Shared — `packages/shared/*.test.ts`.** Pure schema tests: valid input
parses, invalid input fails on the field you expect.

Scheduler code (auto-open/auto-start/reminders) takes an injected `now: Date`
precisely so tests can drive it with a fixed clock — do that instead of
`vi.useFakeTimers` gymnastics or `sleep`.

## 5. House rules that reviewers will hold you to

1. **The contract lives in `packages/shared`.** Both sides import the same Zod
   schema; don't hand-roll a duplicate type. Before you change a response shape
   or a status code, grep `apps/web/src` for the caller.
2. **Comments explain WHY.** The tree is full of comments naming the exact
   production failure a line prevents (`PRAGMA journal_mode=WAL` returning rows,
   the Cloudflare 100 MB layer cap, the double-🟢 race). Keep that standard;
   restating what the code says is noise.
3. **Roles are ranked, not compared by string.** Use `requireRole(min)` /
   `roleAtLeast(role, min)` with `ROLE_RANK` (MEMBER < NET_CONTROL < OFFICER <
   ADMIN). A new endpoint must pick the *lowest* role that legitimately needs it.
4. **Migrations are append-only.** Never edit a migration that has shipped —
   `prisma migrate deploy` runs on every container start against live club
   databases. Add a new migration: `npm -w @hna/api run prisma:migrate -- --name short_description`.
5. **Nothing secret in git.** No tokens, no `dev.db`, no real member data, no
   trademarked college logos (see `themes/README.md`).
6. **Soft delete stays soft.** Sessions and check-ins are FCC-relevant logs;
   hard deletes exist only behind the admin trash UI.

## 6. Commits and pull requests

- Commit messages follow the existing log: `type(scope): summary` in the
  imperative — `feat(web): …`, `fix(api): …`, `chore(deps): …`, `docs: …`.
- One logical change per PR. Dependency bumps ride in their own "wave" commit
  rather than hiding inside a feature.
- Fill in the PR template. Its checklist is the gate chain — tick the boxes
  only after you have actually run the commands.
- If you changed behavior an operator can see (a new env var, a new scheduler,
  a new admin action), update `README.md` and add a line under `Unreleased` in
  `CHANGELOG.md` in the same PR. Documentation drift is how the last README
  ended up describing a dev flow that crashed on its first command.

## 7. Reporting problems

Bugs and feature ideas: use the issue templates under
`.github/ISSUE_TEMPLATE/`. Security vulnerabilities: **do not** open an
issue — follow [SECURITY.md](SECURITY.md).
