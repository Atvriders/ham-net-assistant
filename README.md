# Ham-Net-Assistant

A web app for college amateur-radio clubs to manage repeaters, schedule
weekly nets, run live check-ins, produce FCC-friendly sign-in logs and
participation statistics, and bridge the in-app chat to Discord.

Ships with pickable college themes (K-State, MIT, Georgia Tech, Virginia Tech,
Illinois, plus a neutral default), dark mode by default, mobile responsive,
and auto-refreshing pages so multiple operators can share state in real time.

## Features

### Accounts & roles
- **ADMIN** — manages users, assigns roles, sets the default theme, deletes
  users / sessions / check-ins, restores from trash, configures Discord,
  bulk-imports historical logs, backfills missing names from FCC
- **OFFICER** — manages repeaters and nets, runs net sessions, edits net
  scripts, takes control of an in-progress net, deletes any check-in
- **MEMBER** — self-check-in during a running net, edit/delete own check-ins
  within 5 minutes, submit topic suggestions, post chat messages

First registered user is promoted to ADMIN. Subsequent users default to MEMBER.
New members inherit the global default theme set by an admin.

### Registration
- Two-step flow: callsign → callook.info FCC lookup → details form with
  prefilled name (first + last only)
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
- **Take control** — any officer/admin can take over a running net with
  one click from the Dashboard, Nets list, or RunNetPage
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

### Topics
- Any member can submit a net topic suggestion
- Officers can mark topics USED or DISMISSED
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
  <freq>` on Start net and `🔴 <Net> has ended · N check-in(s) · M min`
  when the net is finalized
- **Scheduled reminders** — admin-configurable times-of-day per reminder
  (e.g. 4:00 PM and 7:30 PM), evaluated in each net's IANA timezone
  (DST-aware via `Intl.DateTimeFormat`)
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

### Live updates
- Pages auto-poll with visibility-aware pausing (no traffic when tab is
  hidden)
- RunNetPage 3s · JoinNetPage 5s · Admin 5s · Dashboard 5-10s · others 10-30s
- Deep-equal gate prevents unnecessary re-renders

### Aesthetic
- IBM Plex Mono / Plex Sans typography pair
- Uppercase tracked microtypography on labels
- Tabular figures on callsigns and frequencies; dot-leader rows for
  repeater data
- Cards have a 2 px ledger stripe in theme primary; featured cards get an
  L-bracket corner tick
- Subtle radial primary-glow + 24 px dot-grid background pattern (adapts to
  every college theme via `color-mix`)
- Dashboard "Next net" hero with a live tabular-mono countdown
- Mobile-responsive: 3-col layouts collapse, modals go full-width, 44px tap
  targets

## Dev

    npm install
    npm run dev:api    # terminal 1 — Express + Prisma on :3000
    npm run dev:web    # terminal 2 — Vite on :5173, proxies /api to :3000

Frontend at http://localhost:5173.

## Test

    npm test

266+ API tests (Vitest + Supertest) · 31 web tests (Vitest + React Testing
Library) · 18 shared schema tests.

## Run with Docker Compose

Uses the prebuilt image from GHCR — no local build required:

    docker compose up -d

Opens on **http://localhost:3045**. First registered user becomes ADMIN.

To build from source instead:

    docker build -f docker/Dockerfile -t hna:local .
    docker run -d --name hna --restart unless-stopped \
      -p 3045:3000 -v hna-data:/data \
      -e JWT_SECRET=change-me-change-me-change-me hna:local

The image is based on `node:20-slim`, runs as non-root user `hna` via a
`gosu` entrypoint that chowns `/data` on startup so bind-mounted or
migrated volumes just work. Built-in HEALTHCHECK on `/api/themes`. Multi-stage
build keeps the runtime image trim.

## Environment

| Var | Required | Description |
|---|---|---|
| `JWT_SECRET` | yes | At least 16 characters, random. Rotating it invalidates all sessions. |
| `REGISTRATION_CODE` | no | If set, new registrations must include this code. Empty = open registration. |
| `DATABASE_URL` | no | SQLite path, defaults to `file:/data/ham.db` in Docker. |
| `PORT` | no | API listen port, default 3000. |
| `LOGO_DIR` | no | Directory for uploaded college logos, default `/data/logos`. |
| `STATIC_DIR` | no | Served SPA dir, defaults to bundled `apps/web/dist`. |
| `DISCORD_ENABLED` | no | `true`/`false` master switch. UI override unless this is set. |
| `DISCORD_BOT_TOKEN` | no | Discord bot token. UI override unless this is set. |
| `DISCORD_CHANNEL_ID` | no | Channel id for chat bridge, reminders, and net notifications. |

Generate a secret with `openssl rand -hex 32`.

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
  college logos are not shipped in this repo — each club provides their own.

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

- Passwords hashed with argon2id
- Sessions are JWT in httpOnly `SameSite=Lax` cookies, 7-day expiry
- Role claim in the token validated against the Zod `Role` enum on every
  request (no silent bypass via forged `role: "SUPERUSER"`)
- `net.scriptMd` redacted server-side from all GET responses for MEMBERs
- CSV export escapes cells beginning with `=+-@` for Excel injection safety
- Logo URL uploader and Google-Docs import URL fetcher reject private IPs
  (RFC1918, link-local, loopback, IMDS) and cap response size
- Stats endpoints require OFFICER or higher
- Callsigns are immutable after registration (PATCH user schemas are
  `.strict()`)
- Soft deletes on sessions and check-ins; hard delete only via admin
  "Delete forever" in trash
- First-user-ADMIN TOCTOU exists on a freshly provisioned instance —
  deploy behind a trusted network for the first registration

## Docs

- Design spec: `docs/superpowers/specs/2026-04-10-ham-net-assistant-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-10-ham-net-assistant.md`
