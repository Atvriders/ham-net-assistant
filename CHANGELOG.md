# Changelog

All notable changes to Ham-Net-Assistant are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Deployments track the `ghcr.io/atvriders/ham-net-assistant:latest` image built
from `master`, so "Unreleased" is what a `docker compose pull` gives you today.
Every entry that changes an operator's world is marked **[operators]**.

## [Unreleased]

Pre-publication hardening pass: a full audit of the app before handing it to a
professional team, plus the repository furniture (license, contribution and
security policies, real operator documentation) that a public project needs.

### Added

- **[operators]** Pre-migration database snapshots. The container entrypoint
  takes a WAL-safe SQLite `VACUUM INTO` snapshot into `/data/backups/` (inside
  the volume) before `prisma migrate deploy` runs, keeping the newest
  `HNA_BACKUP_KEEP` (default 5). Run it on demand with
  `node apps/api/dist/cli/backup.js`; skip it with
  `HNA_SKIP_PRE_MIGRATE_BACKUP`. A failed snapshot warns loudly and does not
  block boot.
- **[operators]** Admin recovery CLI (`apps/api/dist/cli/admin.js`) with
  `list-admins`, `promote <email>` and `set-password <email>`, for the standard
  club failure mode where the only ADMIN graduated.
- **[operators]** Stale-session reaper: a session left LIVE for more than four
  hours is auto-ended at `liveAt + 4h`, so a forgotten net stops sitting on the
  Dashboard and mirroring Discord chatter forever.
- Rate limiting (per IP): 1200 req/min across `/api`, 20 **failed** logins per
  15 min, 30 registrations/hour, and 60/min on the endpoints that make the
  server fetch a remote URL. 429s use the standard API error envelope.
- Helmet security headers, including a Content-Security-Policy tuned to what
  the SPA actually loads (no inline scripts; Google Fonts allowed).
- One shared SSRF guard (`apps/api/src/lib/safeFetch.ts`) for every fetch of a
  user-supplied URL, re-checked on every redirect hop.
- Graceful shutdown: HTTP server, schedulers and the Discord client are closed
  on SIGTERM/SIGINT within a bounded window, so SQLite closes cleanly instead
  of being SIGKILLed with an open WAL.
- Database indexes on `Net.repeaterId` and `NetSession(netId, startedAt)`
  (migration `20260726000000_index_net_repeater_and_session_net`).
- **[operators]** Repository furniture: `LICENSE` (MIT), `CONTRIBUTING.md`,
  `SECURITY.md`, this changelog, a root `.env.example` documenting every
  variable the app reads, issue templates, and a PR template whose checklist is
  the CI gate chain.
- CI: `npm audit` (CRITICAL fails, HIGH reports), a Trivy scan of the image
  that is about to be published, build provenance on the pushed image, least-
  privilege workflow permissions, and grouped weekly Dependabot PRs.

### Changed

- **[operators] BREAKING: `JWT_SECRET` policy.** Minimum length is now 32
  characters and recognizable placeholders (`change-me`, `secret`, `example`,
  …) are rejected at boot. `docker-compose.yml` no longer carries a default
  secret — compose refuses to start unless `JWT_SECRET` is set, and requires
  `REGISTRATION_CODE` to be present (it may be empty). Copy `.env.example` to
  `.env` and generate a secret with `openssl rand -hex 32`.
- **Authorization now reads the role from the database on every request.** The
  session cookie establishes identity only, so demotions and account deletions
  take effect immediately instead of lingering for the life of the token.
- Session lifetime cut from 7 days to 12 hours.
- E-mail addresses are trimmed and lower-cased on registration and login, so
  the binary UNIQUE index behaves like a case-insensitive one. Accounts created
  earlier with capital letters keep working: login falls back to a
  case-insensitive lookup when the exact match misses. The only leftover to
  clean up is a pair of accounts that differ *only* by capitals — see the
  Troubleshooting entry in the README.
- Minimum password length raised from 8 to 12 characters.
- Session reads (`GET /api/sessions*`) now require an account; the repeater
  list, net schedule and theme list remain public.
- **[operators]** The healthcheck (image and compose) probes
  `/api/themes/default`, which touches the database, so a corrupt, locked or
  unmigrated database now reports *unhealthy* instead of serving 200s from
  disk.
- **[operators]** Compose gains `init: true` (clean SQLite shutdown), a memory
  limit, and json-file log rotation so unwatched logs can't fill the disk that
  holds `/data`.
- SQLite pragmas (WAL, busy timeout) are applied before the server accepts its
  first request rather than shortly after.
- CI uses `npm ci` instead of `npm install`, so a drifted lockfile fails the
  build instead of being silently rewritten.
- **[operators] Documentation rewritten.** The README's dev flow used to crash
  on its first command; roles, the PREP → LIVE lifecycle with automatic opening
  and starting, backup/restore, upgrade/rollback and troubleshooting are now
  documented. The April 2026 spec and plan moved to `docs/history/` with
  superseded banners — they describe React 18, Zustand and Node 20, none of
  which is true.
- Package manifests declare `license: MIT` plus description/repository/homepage
  metadata.

### Fixed

- Unknown `/api/*` paths return the JSON error envelope instead of Express's
  HTML "Cannot GET" page.
- Various timezone, dedupe and scheduler edge cases around opening, starting
  and ending sessions (see the test suites added alongside them).

### Security

- Placeholder `JWT_SECRET` values are rejected, closing the case where a club
  deployed with the secret published in this repository and anyone could mint
  themselves an ADMIN cookie.
- Role escalation via a stale or forged cookie is closed by the database-backed
  role lookup.
- SSRF fixes in the logo, log and script importers: redirect hops are
  re-validated, failed DNS resolution no longer passes the private-address
  check, IPv4-mapped IPv6 addresses are classified correctly, and CGNAT space
  (100.64.0.0/10) is blocked.
- Credential guessing is throttled at the login route, and passwords have a
  higher floor.

[Unreleased]: https://github.com/Atvriders/ham-net-assistant/commits/master
