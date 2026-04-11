# Ham-Net-Assistant

A web app for college amateur-radio clubs to manage repeaters, schedule
weekly nets, run live check-ins, and produce FCC-friendly sign-in logs
and participation statistics for funding requests.

Ships with pickable college themes (K-State, MIT, Georgia Tech, Virginia Tech,
Illinois, plus a neutral default), dark mode by default, mobile responsive,
and auto-refreshing pages so multiple operators can share state in real time.

## Features

### Accounts & roles
- **ADMIN** — manages users, assigns roles, sets the default theme, can delete
  users and net sessions
- **OFFICER** — manages repeaters and nets, runs net sessions, edits net scripts
- **MEMBER** — self-check-in during a running net, submit topic suggestions

First registered user is promoted to ADMIN. Subsequent users default to MEMBER.
New members inherit the default theme set by an admin.

### Registration
- Two-step flow: callsign → lookup → details form with autofilled name
- FCC database lookup via callook.info (US callsigns only)
- Unlicensed operators get the shared placeholder callsign `N0CALL`
- Optional invite-code gate via `REGISTRATION_CODE` env var
- Display convention: zeros in callsigns render as slashed zero (`Ø`)

### Repeaters
- Full CRUD for officers, public read for members
- **Auto-discover** local repeaters from your callsign via the Amateur Repeater
  Directory (CC0) with HearHam as a fallback
- **Manual discover** by coordinates (lat/lon or Maidenhead grid square with
  auto-fill from your callsign)
- **CSV import** with CHIRP format auto-detection and a review table
- Each net can reference a primary repeater plus a list of linked repeaters
  (RF/internet linked systems)

### Nets
- Recurring schedule with day/time/timezone
- Primary + linked repeaters for linked systems
- Free-text markdown script (officers only)
- Topic picker when starting a net — pick from member suggestions or enter a
  custom topic; picked topics auto-mark as USED
- Live check-in page for net control (RunNetPage)
- Member self-check-in page with read-along script (JoinNetPage) —
  script is hidden from plain members via server-side redaction
- Check-in with callsign autocomplete and visitor confirm prompt
- Session summary with CSV export and copy-to-clipboard log
- Admins can delete past sessions

### Topics
- Any member can submit a net topic suggestion
- Officers can mark topics USED or DISMISSED
- Members can delete their own OPEN topics

### Stats
- Officer-gated (`/api/stats/*`)
- Per-member participation leaderboard
- Per-net check-in bar chart (Recharts)
- CSV export with Excel-injection-safe encoding
- PDF export via `@react-pdf/renderer`

### Live updates
- Pages auto-poll with visibility-aware pausing
- RunNetPage 3s · JoinNetPage 5s · Admin 5s · Dashboard 5-10s · others 10-30s
- Deep-equal gate prevents unnecessary re-renders

## Dev

    npm install
    npm run dev:api    # terminal 1 — Express + Prisma on :3000
    npm run dev:web    # terminal 2 — Vite on :5173, proxies /api to :3000

Frontend at http://localhost:5173.

## Test

    npm test

71+ API tests (Vitest + Supertest) · 18 shared schema tests · 31 web tests
(Vitest + React Testing Library).

## Run with Docker Compose

Uses the prebuilt image from GHCR — no local build required:

    docker compose up -d

Opens on **http://localhost:3045**. First registered user becomes ADMIN.

To build from source instead:

    docker build -f docker/Dockerfile -t hna:local .
    docker run -d --name hna --restart unless-stopped \
      -p 3045:3000 -v hna-data:/data \
      -e JWT_SECRET=change-me-change-me-change-me hna:local

The image is based on `node:20-slim`, runs as non-root user `hna`, and has
a built-in HEALTHCHECK on `/api/themes`. An entrypoint script chowns the
`/data` volume on startup so bind-mounted or migrated volumes just work.

## Environment

| Var | Required | Description |
|---|---|---|
| `JWT_SECRET` | yes | At least 16 characters, random. All sessions invalidate when rotated. |
| `REGISTRATION_CODE` | no | If set, new registrations must include this code as the invite-code field. Empty = open registration. |
| `DATABASE_URL` | no | SQLite path, defaults to `file:/data/ham.db` in Docker. |
| `PORT` | no | API listen port, default 3000. |
| `LOGO_DIR` | no | Directory for uploaded college logos, default `/data/logos` in production. |
| `STATIC_DIR` | no | Served SPA dir, defaults to bundled `apps/web/dist`. |

Generate a secret with `openssl rand -hex 32`.

## Themes

Six themes ship by default: `default`, `kstate`, `mit`, `georgiatech`,
`virginiatech`, `illinois`. Each has a light and dark palette.

- **Admins** can set the global default theme for new users from the Admin page,
  and override any existing user's theme per-row.
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

## Security notes

- Passwords hashed with argon2id
- Sessions are JWT in httpOnly `SameSite=Lax` cookies, 7 day expiry
- Role claim in the token is validated against the Zod `Role` enum on every
  request (no silent bypass via forged `role: "SUPERUSER"`)
- `net.scriptMd` is redacted server-side from all GET responses when the
  requesting user's role is MEMBER
- CSV export escapes cells beginning with `=+-@` for Excel injection safety
- Logo URL uploader rejects private IPs (RFC1918, link-local, loopback, IMDS)
  and caps response size to 512KB streamed
- Stats endpoints require OFFICER or higher
- Callsigns are immutable after registration (no endpoint accepts callsign
  updates, and user PATCH schemas are `.strict()`)
- First-user-ADMIN TOCTOU exists on a freshly provisioned instance; deploy
  behind a trusted network for the first registration

## Docs

- Design spec: `docs/superpowers/specs/2026-04-10-ham-net-assistant-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-10-ham-net-assistant.md`
