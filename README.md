# Ham-Net-Assistant

A web app for college amateur-radio clubs to manage repeaters, schedule
weekly nets, run live check-ins, produce FCC-friendly sign-in logs and
participation statistics, and bridge the in-app chat to Discord.

Ships with pickable college themes (K-State, MIT, Georgia Tech, Virginia Tech,
Illinois, plus a neutral default), dark mode by default, mobile responsive,
and auto-refreshing pages so multiple operators can share state in real time.

**Start here:** [Quick start](#quick-start) · [Roles](#roles-and-permissions) ·
[Net lifecycle & automation](#net-lifecycle--automation) ·
[Environment](#environment) · [Backup & restore](#backup--restore) ·
[Troubleshooting](#troubleshooting) · [CONTRIBUTING.md](CONTRIBUTING.md) ·
[SECURITY.md](SECURITY.md)

## Quick start

```bash
cp .env.example .env
# put a real secret in it — the app refuses to run with a placeholder
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
docker compose up -d
```

Opens on **<http://localhost:3045>**. The first account you register becomes
ADMIN — do that immediately, before anyone else can. Data lives in the
`hna-data` Docker volume.

Compose deliberately refuses to start unless `JWT_SECRET` is set and
`REGISTRATION_CODE` is present in `.env`. Leaving the join code empty means
open registration; on a publicly reachable URL, set one.

Building from source instead: [Local development](#local-development).

## Features

### Accounts & roles

Four ranked roles: **MEMBER < NET_CONTROL < OFFICER < ADMIN**. Which one you
grant a student decides how much of the club's data they can export, so read
[Roles and permissions](#roles-and-permissions) before handing out OFFICER.

First registered user is promoted to ADMIN. Subsequent users default to MEMBER.
New members inherit the global default theme set by an admin.

### Registration
- Two-step flow: callsign → callook.info FCC lookup → details form with
  prefilled name (first + last only)
- Passwords are 12–128 characters; e-mail addresses are lower-cased on the way
  in so one person can't end up with two accounts differing only in capitals
- Unlicensed operators get the shared placeholder callsign `N0CALL`
- Optional invite-code gate via `REGISTRATION_CODE` env var (hidden from the
  form when empty)
- Display convention: zeros in callsigns render as slashed zero (`Ø`);
  storage stays plain ASCII

### Repeaters
- Full CRUD for officers, public read for members
- **Auto-discover** local repeaters from your callsign via the Amateur
  Repeater Directory (CC0) with HearHam as a fallback
- **Manual discover** by coordinates (lat/lon, or Maidenhead grid square
  with auto-fill from your callsign)
- **CSV import** with CHIRP format auto-detection and an editable review
  table
- Each net references one primary repeater plus a list of linked repeaters
  (RF / internet linked systems); both are shown side-by-side in the run/join
  views

### Nets
- Recurring schedule with day / wall-clock time / IANA timezone
- Markdown or HTML script (DOCX import preserves font color and inline
  formatting via mammoth + DOMPurify); script hidden from members via
  server-side redaction
- **Topic picker** when starting a net — pick from member-submitted
  suggestions or enter a custom topic; picked topics auto-mark as USED
- **Live RunNetPage** for net control with check-in autocomplete, FCC
  fallback name lookup, Enter-to-submit, Backspace-on-empty undo,
  Escape-to-end shortcuts
- **JoinNetPage** for member self-check-in with one-click "Check me in"
- **Take control** — any net-control operator, officer, or admin can take over
  a running net with one click from the Dashboard, Nets list, or RunNetPage
- **Per-session in-app chat** mirrored to Discord; messages survive after
  the session ends and are visible on the SessionSummaryPage
- **End-net review modal** lets net control review the full check-in list
  with timestamps and add notes before finalizing
- **Session summary** with CSV export and a clipboard copy button that
  formats:
  ```
  4/25/26
  Topic: Antennas 101
  NET control: AB0ZW James
  ● KC5QBT Jeff
  ● KF0WBD Bret
  ```
- Same-day duplicate prevention: starting a net for a calendar day where one
  already exists either reuses the active session or 409s if it's already
  ended
- Admin merge tool for any pre-existing duplicates (by net + day)
- **Impromptu nets** — kind `"impromptu"` skips the recurring schedule, the
  reminder scheduler, and both automatic opening and automatic starting;
  create one and start it immediately
- **Saved script library** — reusable script bodies tagged by category
  (`weekly` / `general` / `impromptu`) with a Picker affordance in the net
  edit modal and a "Save as saved script" button to push the current
  editor body into the library
- **24-hour chat backfill** — when a net starts, the chat panel pre-loads
  every `SessionMessage` from the same Net within the last 24 hours
  (soft-deleted sessions excluded), with a "PRE-NET CONTEXT" / "NET
  STARTED" divider and autoscroll to the bottom

### Topics
- Any member can submit a net topic suggestion
- Net control (and above) can mark topics USED or DISMISSED
- Members can delete their own OPEN topics

### Stats
- Officer-gated (`/api/stats/*`)
- Per-member participation leaderboard
- Per-net check-in bar chart (Recharts)
- Per-session detail card listing chronological check-ins, control op, topic
- "Copy log" button per session
- Admin Delete button per session row
- CSV export with Excel-injection-safe encoding and a SESSION block per net
- PDF export via `@react-pdf/renderer` with full per-session detail

### Bulk historical log import (admin)
- Paste from Google Docs (URL or copy-paste) or a local `.md`/`.txt`/`.docx`
- Tolerant parser: dates with annotations like `3/1/25 (70cm rpt)`, double
  slashes, mixed-case `NET control`, compound callsigns (`W0QQQ/AB0ZW`),
  bare callsigns, lowercase callsigns, section headers and prose are skipped
  silently
- Optional FCC name lookup fills missing names during import
- Per-date deduplication against existing sessions and within the same batch
- Dry-run preview before insertion
- **Backfill missing names** — one-click admin tool re-runs FCC lookup on
  existing check-ins where the name is empty or just the callsign

### Discord integration
- **Bidirectional chat bridge** — messages in the in-app ChatBox (during a
  running net) post to the configured Discord channel; messages from the
  Discord channel appear back in the chat tagged `DISCORD/<username>`
- **Bidirectional emoji reactions** — reactions sync both ways with a
  6-emoji quick picker (👍 ❤️ 😂 🎉 📡 ⚡)
- **Net lifecycle notifications** — bot posts `🟢 <Net> is now live on
  <freq>` when the net goes live and `🔴 <Net> has ended · N check-in(s) ·
  M min` when the net is finalized. When the **auto-start scheduler** takes a
  net live and nobody holds net control, the post is instead
  `🟡 <Net> is scheduled to start now … — no net control has taken the mic
  yet`, because claiming a net is live when no one is running it teaches the
  club to ignore the announcement
- **Scheduled reminders** — configured per net as a list of lead times in
  minutes (e.g. `[240, 30]` for 4 h + 30 min before the scheduled start).
  Centralized **Reminder Settings** panel on the Officer Tools page for
  quick on/off per net with a Customize affordance for fine-tuning. New
  nets default to reminders OFF; officers opt in. Impromptu nets are
  excluded. Evaluated in each net's IANA timezone (DST-aware via
  `Intl.DateTimeFormat`).
- **Test button** with diagnostic error messages (token invalid, missing
  intent, channel not in server, missing Send permission, etc.)
- **Env vars override DB settings** — secrets like `DISCORD_BOT_TOKEN` can
  live in env without being committed; UI fields show `(env)` markers when
  env-driven

### Admin tools
- **Recently deleted** card lists soft-deleted sessions and check-ins from
  the last 30 days with Restore / Delete forever buttons
- **Duplicate sessions** card — auto-merge or manual per-group merge with a
  radio picker (most-checkins-win or earliest-startedAt-win strategies)
- **Default theme** picker for new users; per-user theme override
- **Delete user** (cannot self-delete)
- **Backfill names from FCC**

### Officer tools (`/officer-tools`)
Officer- and admin-only page that hosts:
- **Reminder settings panel** — one row per weekly net with an on/off
  switch (toggle ON seeds the default `[240, 30]` minutes; toggle OFF
  clears) and a Customize button that opens the shared net edit modal
- **Saved script library** — full CRUD for scripts (Title / Category /
  Body) using the same WYSIWYG editor; soft-delete via `deletedAt`

### Live updates
- Pages auto-poll with visibility-aware pausing (no traffic when tab is
  hidden)
- RunNetPage + chat 3s · JoinNetPage / Admin / active-nets 5s · Dashboard 10s ·
  nets + repeaters 15s · live-net indicator 17s · presence and summaries 30s
- Deep-equal gate prevents unnecessary re-renders

### Aesthetic — "Calibrated radio console"
- **Type stack**: Big Shoulders Display (industrial signage) for page heads,
  JetBrains Mono for every identifier (callsign, frequency, timestamp, day
  marker, counter chip, kbd label), Sora for body copy
- Sharp 2 px hairlines and corner-bracket Cards in place of soft shadows
- Phosphor-amber primary accent in dark mode; brass-on-cream in the
  logbook-paper light mode (`data-color-mode="light"`)
- Breathing-pulse `<LiveDot>` for live nets; steady `<OnlineDot>` for
  members currently active (heartbeat-based presence, 2 min window)
- Instrument-panel `<Modal>` with focus trap, return-focus, `[ESC]` close
  chip, `▮▮▮` marker; ConfirmModal replaces every native `window.confirm`
- Dashboard hero with mono `T-DD:HH:MM:SS` countdown to the next weekly
  net; ACTIVE / UPCOMING / RECENT sections with calibrated chip dividers
- WYSIWYG net-script editor (TipTap + tiptap-markdown) with a Raw markdown
  toggle for power users; markdown stays the storage format
- WCAG AA on every fg/bg pair in both themes; global `:focus-visible`
  ring; `role="log" aria-live="polite"` on chat + check-in lists
- Mobile-responsive: 3-col layouts collapse, modals go full-width, 44 px
  tap targets, sticky check-in form on RunNet at phone widths

## Roles and permissions

Roles are **ranked**, not compared by name: every gate is "rank ≥ this", so a
higher role can do everything a lower one can (`ROLE_RANK` in
`packages/shared/src/auth.ts`, `requireRole` in
`apps/api/src/middleware/auth.ts`).

> **Give the students who run nets `NET_CONTROL`, not `OFFICER`.**
> `NET_CONTROL` exists exactly so someone can run Tuesday's net without also
> gaining club configuration and the **complete participation export** — every
> check-in ever logged (callsign, name, comment, timestamp) as CSV or PDF,
> which is officer-gated. Over-granting OFFICER is the easiest way to hand out
> more member data than you meant to.

| Can… | anon | MEMBER | NET_CONTROL | OFFICER | ADMIN |
|---|:--:|:--:|:--:|:--:|:--:|
| Browse the repeater list, the net schedule, themes | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read sessions and past session summaries | — | ✅ | ✅ | ✅ | ✅ |
| Read the net script (`scriptMd`) | — | — | — | ✅ | ✅ |
| Check in to a live net, chat, react, presence | — | ✅ | ✅ | ✅ | ✅ |
| Edit/delete **own** check-in (5 min, net still running) | — | ✅ | ✅ | ✅ | ✅ |
| Submit a topic suggestion; delete own OPEN one | — | ✅ | ✅ | ✅ | ✅ |
| See the member directory (callsign + name) | — | ✅ | ✅ | ✅ | ✅ |
| Open a session (PREP) and press **START NET** | — | — | ✅ | ✅ | ✅ |
| End the net, edit session notes, set the topic | — | — | ✅ | ✅ | ✅ |
| Take or transfer net control | — | — | ✅ | ✅ | ✅ |
| Edit or delete **any** check-in | — | — | ✅ | ✅ | ✅ |
| Mark topic suggestions USED / DISMISSED | — | — | ✅ | ✅ | ✅ |
| Create/edit/delete nets and repeaters | — | — | — | ✅ | ✅ |
| Repeater auto-discovery | — | — | — | ✅ | ✅ |
| Read the saved script library (`GET /api/scripts`) | — | ✅ | ✅ | ✅ | ✅ |
| Create/edit/delete saved scripts | — | — | — | ✅ | ✅ |
| **Stats + CSV/PDF participation export** | — | — | — | ✅ | ✅ |
| Users: list, change roles, delete, set theme | — | — | — | — | ✅ |
| Trash (restore / delete forever), merge duplicates | — | — | — | — | ✅ |
| Delete a net session | — | — | — | — | ✅ |
| Bulk historical log import, FCC name backfill | — | — | — | — | ✅ |
| Discord config + test, default theme, logo upload | — | — | — | — | ✅ |

The anonymous reads that remain are deliberate, and this is the complete list:
`GET /api/repeaters`, `GET /api/nets`, `GET /api/themes`,
`GET /api/auth/config` (whether an invite code is required),
`GET /api/discord/status` (a single on/off boolean for the chat header) and
`GET /api/callsign-lookup/:callsign`. A club's repeater list and net schedule
are public-facing information and the login page needs the theme list. Check-in
logs are **not** — session reads require an account. Net scripts are redacted
server-side for anyone below OFFICER, on every response shape that can carry a
net.

`GET /api/callsign-lookup/:callsign` is the one anonymous route that makes the
server perform an **outbound** request (to callook.info) on the caller's
behalf. The callsign is pattern-validated before use, so it cannot be steered
at another host, and the route sits behind the 60/min outbound rate limiter —
but it stays unauthenticated because the registration form calls it before the
user has an account.

**Known gap — net scripts vs the script library.** Two different things hold
script text and they are gated differently:

- `Net.scriptMd` is redacted below OFFICER (`canViewScripts` in
  `apps/api/src/lib/scriptGate.ts`), so a `NET_CONTROL` operator sees an empty
  script panel while running the net.
- The **saved script library** (`GET /api/scripts`) is `requireAuth` only and
  returns each script's full `body`, so any MEMBER can read every saved script.

The net redaction is therefore not a confidentiality boundary in practice —
anything an officer saves to the library is member-readable. Treat the library
as club-visible, and if a script must be officer-only, don't save it there.
Whoever picks this up should make the two gates agree, in whichever direction
the club actually wants.

Only ADMIN can change roles (`PATCH /api/users/:id/role`). The session cookie
establishes *which* user is calling; the role itself is read from the database
on every request, so promotions, demotions and account deletions take effect on
the caller's very next request — no re-login, no waiting for the token to
expire. The web client is the one thing that lags: it reads `/auth/me` once
when the page loads and caches it, so a member who is promoted while their tab
is open has the new permissions immediately but has to **reload the page** to
see the new menu.

## Net lifecycle & automation

A session has two states before it ends, and **the server moves weekly nets
between them on its own — nobody has to press anything.**

```
        auto-open (15 min early)              auto-start (at start time,
        or "Open net" pressed                  15-min grace) or START pressed
                  │                                      │
 (no session) ────┴────► PREP ────────────────────────────┴────► LIVE ──► ended
                        liveAt = null                          liveAt set
```

**PREP** — the session row exists. Net control can set the topic, read/edit the
script, and use the chat. **No check-ins are accepted** (409 "Net is
preparing") and **nothing is posted to Discord**.

**LIVE** — check-ins are open and the bot posts
`🟢 <Net> is now live on <freq>` to the configured Discord channel (see
[Auto-start](#auto-start) for the one case that posts `🟡` instead).

### Auto-open

`apps/api/src/lib/autoOpenScheduler.ts`, ticks every 60 s.

- For every **active weekly** net, when now is within **15 minutes** before the
  next scheduled occurrence, it creates a PREP session with no control operator.
- Deduped against the occurrence's own calendar day *in the net's timezone*, so
  it never creates a second session for an occurrence and never collides with
  an operator who opened one manually.
- Whoever presses "Open net" afterwards adopts the unclaimed session and
  becomes net control; a session that already has a control op keeps it.
- Makes **no Discord post**.

### Auto-start

`apps/api/src/lib/autoStartScheduler.ts`, ticks every 30 s.

- Any open PREP session on a **weekly** net goes LIVE when the net's scheduled
  start arrives in the net's own timezone, within a **15-minute grace window**
  (later than that, a forgotten PREP session is left alone).
- A PREP session opened more than 24 h before that start is skipped, so last
  week's abandoned session can't surprise-start alongside this week's.
- It runs the same code path as the START button, **including the Discord
  announcement**. It does *not* assign a control operator, so a
  scheduler-started net can be live with nobody holding control until someone
  takes it — and that is exactly the case the announcement changes wording for:
  with no control op the post is `🟡 <Net> is scheduled to start now … — no net
  control has taken the mic yet. Any operator can open the console and take
  control.` A scheduler start on a session someone *has* claimed still posts
  the normal `🟢 … is now live`.
- Race-safe: manual start and scheduler use a guarded update, so the
  announcement fires exactly once.

The run console shows this as a per-second `// AUTO-START IN MM:SS` strip that
becomes the flashing 5-minute announcement and then `// STARTING…`. The browser
never starts anything itself; it just re-fetches when the clock hits zero.

### Stale-session reaper

`apps/api/src/lib/staleSessionReaper.ts`, sweeps every 5 minutes.

A session that went LIVE and was never ended would stay on the Dashboard
forever and keep mirroring Discord chatter. Any session live for more than
**4 hours** is auto-ended, with `endedAt` recorded as `liveAt + 4h` (not "now",
so a weekend outage can't record a three-day net). PREP sessions are never
touched, and no Discord message is posted for a reaped session.

### Opting out

There is **no global off switch** — all three schedulers start unconditionally
in `apps/api/src/index.ts`. Opt out per net:

- **Mark the net inactive**: `PATCH /api/nets/:id` with `{"active": false}`
  (OFFICER+). Auto-open only considers `active: true` weekly nets. The net edit
  modal has no visible Active toggle today, so this is an API call.
- **Or make it impromptu** (`kind: "impromptu"`): impromptu nets are excluded
  from auto-open, auto-start, and Discord reminders. They go live only when an
  operator presses START.

One caveat: auto-**start** keys off "open PREP session on a weekly net" and
does not re-check `active`. Deactivating a net stops sessions from being opened
automatically, but a PREP session someone opens by hand on an inactive weekly
net will still go live at its scheduled time.

## Local development

`npm install` alone is not enough, and **nothing loads a `.env` file into the
server** — the API reads real environment variables only (there is no dotenv
dependency anywhere). This sequence works from a fresh clone:

```bash
npm install
npm -w @hna/shared run build          # api + web import @hna/shared from dist/
npx -w @hna/api prisma generate       # generates the Prisma client

# create/upgrade the dev database (DATABASE_URL is required — see below)
DATABASE_URL="file:./dev.db" npm -w @hna/api run prisma:deploy
```

Then two terminals:

```bash
# terminal 1 — Express + Prisma on :3000
JWT_SECRET=$(openssl rand -hex 32) DATABASE_URL="file:./dev.db" npm run dev:api

# terminal 2 — Vite on :5173, proxies /api to :3000
npm run dev:web
```

Frontend at <http://localhost:5173>. First registered user becomes ADMIN.

Generate the secret **once** and keep it in a file you `source` — not a `.env`,
which the server will not read — or every restart logs you out:

```bash
printf 'export JWT_SECRET=%s\nexport DATABASE_URL="file:./dev.db"\n' \
  "$(openssl rand -hex 32)" > .devenv        # .devenv and .env* are gitignored
source .devenv && npm run dev:api
```

`.gitignore` covers `.devenv`, `.env` and `.env.*` (with `.env.example`
deliberately re-included), so none of these can be committed by accident.

Two things bite everyone once:

- **`JWT_SECRET` is mandatory, ≥ 32 characters, and must not look like a
  placeholder** (values containing `change-me`, `secret`, `example`… are
  rejected by name). Otherwise the process dies immediately — a raw `ZodError`
  in dev, a single `FATAL: invalid environment …` line and exit code 1 when
  `NODE_ENV=production`.
- **`DATABASE_URL` is mandatory in practice.** `env.ts` declares a default, but
  the Prisma client reads `process.env.DATABASE_URL` itself and fails with
  `Environment variable not found: DATABASE_URL`. Relative `file:` paths
  resolve against `apps/api/prisma/`.

Rebuild `@hna/shared` after every schema change — the other workspaces consume
its compiled output, not its sources.

Node 24 is what CI and the Docker image use; Node 20 LTS also works today.

## Test

```bash
npm test            # shared + api + web — no environment setup needed
```

900+ tests across three workspaces: Zod schema tests (`packages/shared`),
integration tests against a real throwaway SQLite database (`apps/api`, Vitest
+ Supertest), and component tests (`apps/web`, Vitest + React Testing Library +
jsdom). The runner prints the current count — this README deliberately doesn't,
because that number moves with every PR.

One workspace at a time works too — `apps/api/test/helpers.ts` sets a
policy-compliant `JWT_SECRET` before anything imports `src/env.ts`:

```bash
npm -w @hna/api run test
npm -w @hna/web run test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full gate chain and the test
conventions to follow.

## Run with Docker Compose

Uses the prebuilt image from GitHub Container Registry
(`ghcr.io/atvriders/ham-net-assistant:latest`) — no local build required:

```bash
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
docker compose up -d
```

Opens on **<http://localhost:3045>**. First registered user becomes ADMIN.

Only the variables listed in `docker-compose.yml`'s `environment:` block reach
the container. Putting `DISCORD_BOT_TOKEN` in `.env` alone does nothing — add
it to that block too, or configure Discord from the Admin page (the usual path).

To build from source instead:

```bash
docker build -f docker/Dockerfile -t hna:local .
docker run -d --name hna --restart unless-stopped \
  -p 3045:3000 -v hna-data:/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" hna:local
```

The image is based on `node:24-bookworm-slim` (bookworm pinned deliberately:
Prisma 6's engine target is `debian-openssl-3.0.x`), and runs as the non-root
user `hna` via a `gosu` entrypoint that chowns `/data` on startup so
bind-mounted or migrated volumes just work. Every start snapshots the database
and then runs `prisma migrate deploy` — see
[Backup & restore](#backup--restore). The multi-stage build keeps the runtime
image trim; it deliberately ships **without** `wget` and without the `sqlite3`
CLI, which is why the healthcheck uses node's built-in `http` and the backup
goes through Prisma. The healthcheck probes `/api/themes/default`, which reads
the database, so an unmigrated or corrupt database reports unhealthy rather
than serving 200s off disk.

Compose also sets `init: true` (so `docker compose stop` reaches node and
SQLite closes cleanly instead of being SIGKILLed with the WAL open), a
`mem_limit` so one runaway PDF/CSV export can't swap the host, and json-file
log rotation so unwatched logs can't fill the disk that holds `/data`.

Run **one replica**. The auto-open, auto-start and reaper schedulers assume a
single process; guard-updates keep a second one from double-posting, but
multi-replica scheduling is not a supported configuration.

### CI / image publishing

GitHub Actions (`.github/workflows/ci.yml`) runs on pull requests and on every
push to `master`:

- **build-and-test** — `npm ci` (not `install`, so a drifted lockfile fails
  loudly), build `@hna/shared`, `prisma generate`, `npm run typecheck`,
  `eslint . --max-warnings=0` (ESLint 10 flat config), the full test suite, the
  production build, then `npm audit` — CRITICAL fails the build, HIGH is
  reported without blocking
- **docker** — multi-stage build, Trivy scan of the exact image
  (HIGH/CRITICAL with a fix available fails; waivers live in
  `docker/.trivyignore` with a justification and an expiry), then push two tags
  to GHCR with build provenance attached:
  - `ghcr.io/atvriders/ham-net-assistant:latest`
  - `ghcr.io/atvriders/ham-net-assistant:<commit-sha>`

Workflow permissions default to `contents: read`; only the docker job asks for
`packages: write`. Auth uses the built-in `GITHUB_TOKEN` — no manual PAT
required. Pull side is public; no auth needed for `docker compose pull` /
`docker pull`. Dependabot opens grouped weekly update PRs
(`.github/dependabot.yml`).

## Environment

Full annotated list with placeholder values: **[.env.example](.env.example)**.

| Var | Required | Description |
|---|---|---|
| `JWT_SECRET` | **yes** | Session signing key. ≥ 32 characters **and** not a recognizable placeholder — values containing `change-me`, `changeme`, `secret`, `please-change` or `example` are rejected at boot. Generate with `openssl rand -hex 32`. Rotating it logs everyone out. |
| `DATABASE_URL` | yes in practice | SQLite URL. Baked into the image as `file:/data/ham.db`. Required when running from source: Prisma reads it directly and `env.ts`'s default never reaches it. |
| `REGISTRATION_CODE` | no | If set, new registrations must include this code. Empty = open registration. |
| `PORT` | no | API listen port, default 3000. Compose maps host 3045 → 3000. |
| `NODE_ENV` | no | `development` / `production` / `test`. Compose sets `production`, which also makes the session cookie `Secure`. |
| `STATIC_DIR` | no | Served SPA dir; empty falls back to `../web/dist`. The image sets `/app/apps/web/dist`. |
| `LOGO_DIR` | no | Uploaded college logos. Default `/data/logos` in production, `./data/logos` otherwise. |
| `DISCORD_ENABLED` | no | `true`/`false` master switch. Overrides the DB setting when set. |
| `DISCORD_BOT_TOKEN` | no | Discord bot token. Overrides the DB setting when set. |
| `DISCORD_CHANNEL_ID` | no | Channel id for chat bridge, reminders, and net notifications. |
| `HNA_BACKUP_DIR` | no | Where pre-migration snapshots are written. Default: `backups/` beside the database file (`/data/backups` in Docker). |
| `HNA_BACKUP_KEEP` | no | How many snapshots to retain (default 5); older ones are pruned. |
| `HNA_SKIP_PRE_MIGRATE_BACKUP` | no | Any non-empty value skips the pre-migration snapshot. Dev containers only. |

`docker-compose.yml` additionally requires `JWT_SECRET` to be **set and
non-empty** and `REGISTRATION_CODE` to be **present** (empty is allowed, and
means open registration) — compose refuses to start otherwise, by design.
`cp .env.example .env` gives you both lines.

Who reads what: the repo-root `.env` is consumed by **docker compose only**;
the API process reads real environment variables; the **Prisma CLI** reads a
`.env` from its working directory — which is why an `apps/api/.env` can make
migrations work while the server still refuses to boot.

## Backup & restore

Everything lives in one SQLite file inside the `hna-data` volume:
`/data/ham.db`, plus uploaded logos in `/data/logos/`. That file is the club's
only copy of years of net logs.

> **A plain `cp /data/ham.db backup.db` is NOT a safe backup.** The database
> runs in **WAL mode** (`PRAGMA journal_mode=WAL`), so recently committed
> transactions can still be sitting in the `ham.db-wal` sidecar. Copying the
> main file alone can hand you a database missing the last net — or a torn one.
> Either copy `ham.db`, `ham.db-wal` **and** `ham.db-shm` together with the
> container stopped, or take a WAL-aware snapshot as below.

### Automatic pre-migration snapshots

The container entrypoint snapshots the database **before**
`prisma migrate deploy` runs on every start:

- Taken with SQLite `VACUUM INTO`, which is WAL-safe and produces one
  consistent, fully-checkpointed file.
- Written **inside the volume** at
  `/data/backups/pre-migrate-<UTC-timestamp>.db` (override with
  `HNA_BACKUP_DIR`) — anywhere else would evaporate with the container.
- The newest `HNA_BACKUP_KEEP` (default 5) are kept; older ones are pruned.
- A failed snapshot is loud in the logs but does **not** block boot: the club
  getting its app back matters more, and a half-written file is deleted rather
  than left looking restorable. Watch for
  `[entrypoint] WARNING: pre-migration snapshot failed`.
- Set `HNA_SKIP_PRE_MIGRATE_BACKUP` to any non-empty value to skip it (dev
  containers only).

These protect you from a bad migration or a surprise `:latest`. They are **not**
an offsite backup and they die with the volume.

```bash
docker compose exec hna ls -lh /data/backups     # what you have
docker compose logs hna | grep '\[backup\]'      # what happened at boot
```

### Taking a backup yourself

The same snapshot, on demand, safe while the app is running:

```bash
docker compose exec -u hna hna node apps/api/dist/cli/backup.js
docker compose cp hna:/data/backups ./hna-backups    # then copy it OFF this host
```

Logos are not in the database — grab them too:

```bash
docker run --rm -v hna-data:/data -v "$PWD":/out alpine \
  tar czf /out/hna-logos.tgz -C /data logos
```

A weekly copy plus one before every upgrade is plenty for a club — as long as
it lives somewhere that isn't this machine.

### Restoring

From a snapshot that is still in the volume (the usual case — pick the one you
want with `docker compose exec hna ls -lh /data/backups`):

```bash
docker compose down                     # stop all writers first

docker run --rm -v hna-data:/data alpine sh -c '
  SNAP=/data/backups/pre-migrate-20260101T000000Z.db;   # <- the one you picked
  test -f "$SNAP" || { echo "no such snapshot"; exit 1; };
  cp /data/ham.db /data/ham.db.broken-$(date -u +%Y%m%dT%H%M%SZ) 2>/dev/null;
  rm -f /data/ham.db-wal /data/ham.db-shm;
  cp "$SNAP" /data/ham.db'

docker compose up -d
docker compose logs -f hna
```

Restoring a file you took off the host is the same, with the directory holding
it mounted as well — add `-v "$PWD":/in` and point `SNAP` at `/in/<file>.db`.

Notes:

- **Delete the `-wal`/`-shm` sidecars** when you swap the main file. A stale WAL
  belonging to the old database is how a restore turns into corruption.
- Ownership fixes itself: the entrypoint `chown`s `/data` to `hna` on every
  start. If you ever need to do it by hand:
  `docker compose exec -u root hna chown -R hna:hna /data`.
- Restoring an **older** database into a **newer** image is fine — startup runs
  `prisma migrate deploy` and rolls it forward. The reverse is not; see below.

## Upgrade & rollback

```bash
docker compose exec -u hna hna node apps/api/dist/cli/backup.js   # belt and braces
docker compose pull
docker compose up -d
docker compose logs -f hna      # watch the [backup] and migration lines
docker compose ps               # healthy?
```

`pull_policy: always` means a plain `docker compose up -d` also picks up a new
`:latest`. Every start applies pending migrations automatically.

**Rollback.** CI publishes an immutable SHA tag for every build, so pinning is
the rollback:

```yaml
    image: ghcr.io/atvriders/ham-net-assistant:<commit-sha>
    pull_policy: missing        # stop compose pulling :latest over your pin
```

> **Migrations do not roll back.** `prisma migrate deploy` is forward-only. If
> the version you are leaving added a migration, the schema stays migrated and
> the older image may fail against it. Crossing a migration boundary means
> restoring the pre-upgrade snapshot from `/data/backups` (see
> [Restoring](#restoring)) — which is exactly why that snapshot is taken before
> the migration runs.

Check whether a migration is involved before rolling back:

```bash
git log --oneline <old-sha>..<new-sha> -- apps/api/prisma/migrations
```

## Troubleshooting

**The API exits instantly complaining about `JWT_SECRET`** (a `ZodError` in
dev, a one-line `FATAL: invalid environment …` and exit code 1 in production).
The value is unset, shorter than 32 characters, or a recognizable placeholder.
Nothing reads a `.env` for the server: export it
(`JWT_SECRET=$(openssl rand -hex 32) npm run dev:api`) or put it in the compose
`environment:` block.

**`Environment variable not found: DATABASE_URL`.**
Prisma reads this one directly; the default in `env.ts` never reaches it.
Export `DATABASE_URL="file:./dev.db"` for local runs. In Docker it is baked in.

**Compose refuses to start because of `JWT_SECRET`.**
That is the guard against booting a public deployment with a placeholder
secret. Put a real one in `.env`: `openssl rand -hex 32`.

**`The table main.Net does not exist` and every request 500s.**
Migrations were never applied to this database:
`DATABASE_URL="file:./dev.db" npm -w @hna/api run prisma:deploy`. In Docker
this runs at container start — read the logs for a migration failure.

**Imports of `@hna/shared` fail, or `tsc` can't find its types.**
`packages/shared/dist` is missing; `npm install` does not build workspaces.
`npm -w @hna/shared run build`.

**The container reports `unhealthy` while the app clearly works.**
The compose healthcheck **overrides** the image's `HEALTHCHECK`. The runtime
image ships no `wget`, so a `wget`-based probe fails `exec` on every attempt.
Reproduce the real probe by hand:
`docker compose exec hna node -e "require('http').get('http://127.0.0.1:3000/api/themes/default',r=>console.log(r.statusCode))"`.
The probe hits `/api/themes/default` deliberately: it reads the database, so a
corrupt, locked or unmigrated database reports **unhealthy** instead of serving
200s from a theme file on disk. Anything other than 200 fails the probe.

**Everyone was logged out at once.**
`JWT_SECRET` changed — including the case where compose silently fell back to a
different default. Sessions are stateless JWTs signed with it; rotating it
deliberately is the "log everyone out now" lever.

**Did a demotion take effect?**
Yes, immediately. The role is re-read from the database on every request, and a
deleted account's cookie is treated as anonymous from that moment. What a role
change cannot do is invalidate a *stolen* cookie for that user — only expiry
(12 h) or rotating `JWT_SECRET` does that.

**"First user becomes ADMIN" didn't happen, or nobody has the admin password.**
That bootstrap only fires on an empty database. Recover from a shell:

```bash
docker compose exec -u hna hna node apps/api/dist/cli/admin.js list-admins
docker compose exec -u hna hna node apps/api/dist/cli/admin.js promote you@club.edu
docker compose exec -u hna hna node apps/api/dist/cli/admin.js set-password you@club.edu
```

Use `-u hna`: running as root against a WAL database leaves root-owned
`-wal`/`-shm` sidecars the service can no longer write.

**A session appeared, or a net went live, with nobody touching it.**
Working as designed — see
[Net lifecycle & automation](#net-lifecycle--automation) (auto-open 15 minutes
early, auto-start at the scheduled time), including how to opt a net out.

**A net went live at the wrong time.**
Everything is evaluated in the **net's own IANA timezone**, not the server's
and not the browser's. Check the net's `timezone` and `startLocal`: a net
created with `UTC` fires at UTC.

**Discord isn't posting.**
Use the Admin page's Test button — it names the failure (invalid token, missing
MESSAGE CONTENT intent, channel not in the server, missing Send permission).
Env vars override the UI values, and the UI shows an `(env)` marker when they do.

**"Too many failed sign-in attempts" during a club meeting.**
Rate limits are per IP, and a whole campus usually shares one. Only *failed*
logins count (20 per 15 min); successful ones don't. Wait it out, or check
`trust proxy` if you put an extra reverse proxy in front of the app — one
misconfigured hop makes every request look like it comes from one address.

**Fonts or styles look wrong, with CSP errors in the browser console.**
The Content-Security-Policy allows styles/fonts from `fonts.googleapis.com` and
`fonts.gstatic.com` and nothing else, and no inline `<script>` at all. A
customization that adds a new external asset host has to add it to the CSP in
`apps/api/src/app.ts`.

**A member registered before the e-mail-normalization change.**
They can still sign in: login lower-cases what the member types, and when that
misses it falls back to a case-insensitive `LOWER(email)` lookup, so a row
stored as `Bob@X.co` still authenticates (`apps/api/src/routes/auth.ts`). No
action is required.

The one thing that *is* worth cleaning up is **two accounts that differ only by
capitals** — the UNIQUE index on `email` is binary, so both could be created
before normalization existed, and each holds part of the member's history.
Decide which one keeps the history and delete the other from the Admin page.

To normalize the stored addresses anyway (cosmetic — it makes the Admin list
consistent), snapshot first, because this is not reversible:

```bash
docker compose exec -u hna hna node apps/api/dist/cli/backup.js   # first
docker compose exec -u hna hna sh -c \
  "echo 'UPDATE User SET email = lower(email);' | \
   npx -w @hna/api prisma db execute --schema /app/apps/api/prisma/schema.prisma --stdin"
```

A UNIQUE-constraint failure there means you still have a duplicate pair to
resolve as above; nothing is changed when it fails.

**Port 3045 is already in use.**
Change the host side of the mapping in `docker-compose.yml` (`"3046:3000"`);
leave the container side at 3000 or the healthcheck breaks.

**`SQLITE_BUSY` / "database is locked" in the logs.**
WAL and a 5 s busy timeout are set at boot. Persistent locking usually means a
second writer on the same file — an `sqlite3` shell, a stray container, or a
backup tool holding a write lock. One writer only.

Filing a bug? Include the image tag or commit SHA, the role involved, and
`docker compose logs --tail=200 hna` with secrets redacted — the
[issue templates](.github/ISSUE_TEMPLATE) ask for exactly that.

## Themes

Six themes ship by default: `default`, `kstate`, `mit`, `georgiatech`,
`virginiatech`, `illinois`. Each has a light and dark palette.

- **Admins** can set the global default theme for new users from the Admin
  page, and override any existing user's theme per-row.
- **Each user** can pick their own from Settings; the choice persists to the
  server (`User.collegeSlug`) and survives login on other devices.
- **Anonymous visitors** inherit the global default on first load.
- **Dark mode** is the default color mode; users toggle in Settings.
- **Logo upload** — admins can upload a square logo per theme via the Theme
  Picker. URL import (server-side fetch) or file upload with client-side
  cropper. Files persist at `$LOGO_DIR/<slug>.{svg,png,jpg}`. Trademarked
  college logos are not shipped in this repo — each club provides their own
  (see `themes/README.md`).

## Data sources

Repeater discovery tries these sources in order, showing the source used:

1. **Amateur Repeater Directory (ARD)** — CC0 licensed community dataset,
   ~9,300 repeaters, github-hosted JSON, cached 6h. Primary source.
2. **HearHam** — community repeater database, ~21k rows worldwide, cached 6h.
   Fallback when ARD doesn't cover the area or is unreachable.

RepeaterBook is unavailable — their API was gated behind approved tokens
in March 2026 and their policy prohibits public-facing derived APIs.

Callsign-to-name lookup uses **callook.info** (US FCC ULS proxy).

## Discord setup

1. https://discord.com/developers/applications → New Application → Bot →
   Reset Token → copy
2. Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents
3. OAuth2 → URL Generator → scope `bot`; permissions: View Channel, Send
   Messages, Read Message History, Add Reactions
4. Visit the generated URL and authorize the bot into your server
5. Discord Developer Mode on → right-click the channel → Copy Channel ID
6. Admin page → Discord integration → paste token + channel id, check
   Enabled, Save → Send test message

The test button surfaces specific failures (`TokenInvalid`, missing intent,
channel not in server, missing permission) so misconfig is debuggable
without `docker logs`.

## Security notes

Reporting a vulnerability: **[SECURITY.md](SECURITY.md)** — privately, never as
a public issue.

- Passwords hashed with argon2id, 12-character minimum
- Security headers via Helmet, including a CSP tuned to what the SPA actually
  loads (`script-src 'self'`, no `unsafe-inline` for scripts; Google Fonts
  allowed for styles/fonts)
- Per-IP rate limits: 1200 req/min across `/api`, 20 **failed** logins per
  15 min, 30 registrations/hour, 60/min on the routes that make the server
  fetch something on your behalf. `trust proxy` is set to exactly one hop (the
  Cloudflare Tunnel) so `X-Forwarded-For` can't be spoofed past the limiter
- Sessions are JWT in httpOnly `SameSite=Lax` cookies with a **12-hour** expiry,
  `Secure` when `NODE_ENV=production`. The cookie is the whole credential, so
  the lifetime is deliberately short; there is no per-session revocation —
  rotating `JWT_SECRET` invalidates all of them at once
- The token establishes identity only. **The role is read from the database on
  every request** and parsed through the Zod `Role` enum fail-closed, so a
  forged claim buys nothing, a demotion applies immediately, and a deleted
  user's cookie stops working
- `JWT_SECRET` is validated at boot: ≥ 32 chars and no placeholder values, so a
  deployment can't quietly run on the secret printed in the public repo
- Rank-based authorization (`ROLE_RANK`), so a gate can't be defeated by a role
  string that merely *looks* privileged
- `net.scriptMd` redacted server-side from all GET responses below OFFICER
- CSV export escapes cells beginning with `=+-@` for Excel injection safety
- Every fetch of a user-supplied URL (theme logo import, Google-Docs log
  import, script import) goes through one shared SSRF guard that re-checks
  every redirect hop and rejects loopback, RFC1918, link-local, CGNAT and
  cloud-metadata addresses, with a response size cap
- Stats endpoints require OFFICER or higher
- Callsigns are immutable after registration (PATCH user schemas are
  `.strict()`)
- Soft deletes on sessions and check-ins; hard delete only via the admin
  "Delete forever" in trash
- First-user-ADMIN promotion runs inside `prisma.$transaction` so two
  concurrent first registrations can't both win the ADMIN seat
- Duplicate non-`N0CALL` callsigns rejected at registration with 409
- JWT verify pins `algorithms: ['HS256']`; sign pins the matching algorithm

## Docs

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, the gate chain, test conventions,
  commit and PR expectations
- [SECURITY.md](SECURITY.md) — reporting a vulnerability, scope, response times
- [CHANGELOG.md](CHANGELOG.md) — what changed, newest first
- [.env.example](.env.example) — every variable the app reads, annotated
- `docs/history/` — the original April 2026 design spec and build plan, kept
  for archaeology only. **Superseded**: they describe React 18, Zustand, Node
  20 and a three-role model, none of which is true now. Don't implement from
  them.

## License

[MIT](LICENSE) © Atvriders. College names, marks, and logos referenced by the
themes belong to their respective owners; this repo ships colors only.
