# Ham-Net-Assistant — Design Spec

**Date:** 2026-04-10
**Status:** Approved for implementation planning
**Owner:** Atvriders

## Purpose

A web app for college amateur-radio clubs to manage repeaters, schedule weekly nets, run live check-ins, and produce FCC-friendly sign-in logs and participation statistics for funding requests. Ships with pickable college themes (colors, fonts, logo slot) so each club can brand the app to their school.

Primary users: college ham-radio club members and officers. Goals: train new operators, ease officer transitions, generate credible activity reports for faculty sponsors and ARRL.

## High-Level Approach

Monorepo (npm workspaces) with a React + Vite frontend and an Express + Prisma + SQLite backend sharing Zod-validated types. A single multi-stage Dockerfile builds the frontend, bundles it into the API server, and serves everything on one port. SQLite lives in a mounted volume. Deployment target is "Dockerfile only" — decide hosting later.

## Repo Layout

```
ham-net-assistant/
├── apps/
│   ├── web/          # Vite + React 18 + TS + Zustand + React Router
│   └── api/          # Express + TS + Prisma + SQLite + Zod + JWT
├── packages/
│   └── shared/       # Zod schemas → inferred TS types, shared constants
├── themes/           # College theme JSON + CSS vars + logo slot
├── docker/
│   └── Dockerfile    # Multi-stage: build web → copy into api → serve
├── docker-compose.yml
├── .github/workflows/ci.yml
└── package.json      # npm workspaces
```

### Stack

- **Frontend:** React 18, TypeScript (strict), Vite 5, React Router, Zustand, plain CSS driven by CSS custom properties, Recharts for stats.
- **Backend:** Node 20, Express, TypeScript (strict), Prisma, SQLite, Zod, argon2, jsonwebtoken, @react-pdf/renderer.
- **Shared:** `packages/shared` exports Zod schemas used for both frontend form validation and backend request validation. Single source of truth, no drift.
- **Tooling:** ESLint + Prettier, Vitest (web, api, shared), Supertest for HTTP tests, GitHub Actions CI.

### Runtime model

Single Node process. Express serves `/api/*` and falls through to the built React SPA for all other routes. One port exposed from the container. SQLite file at `/data/ham.db` in a Docker volume.

## Data Model (Prisma)

```prisma
model User {
  id                 String       @id @default(cuid())
  callsign           String       @unique          // uppercased on save
  name               String
  email              String       @unique
  passwordHash       String
  role               Role         @default(MEMBER) // MEMBER | OFFICER | ADMIN
  collegeSlug        String?                       // which theme is "theirs"
  createdAt          DateTime     @default(now())
  checkIns           CheckIn[]
  controlledSessions NetSession[] @relation("ControlOp")
}

model Repeater {
  id         String   @id @default(cuid())
  name       String                     // "KSU Main 146.760"
  frequency  Float                      // MHz
  offsetKhz  Int                        // -600, +600, 0
  toneHz     Float?                     // CTCSS, nullable
  mode       String                     // "FM" | "DMR" | "D-STAR" | "Fusion"
  coverage   String?                    // free text notes
  latitude   Float?
  longitude  Float?
  createdAt  DateTime @default(now())
  nets       Net[]
}

model Net {
  id         String       @id @default(cuid())
  name       String                     // "Wednesday Club Net"
  repeaterId String
  repeater   Repeater     @relation(fields: [repeaterId], references: [id])
  dayOfWeek  Int                        // 0=Sun..6=Sat
  startLocal String                     // "HH:mm" in the Net's timezone
  timezone   String                     // IANA, e.g. "America/Chicago"
  theme      String?                    // weekly theme
  scriptMd   String?                    // user-entered script, markdown
  active     Boolean      @default(true)
  sessions   NetSession[]
}

model NetSession {
  id          String    @id @default(cuid())
  netId       String
  net         Net       @relation(fields: [netId], references: [id])
  startedAt   DateTime
  endedAt     DateTime?
  controlOpId String?
  controlOp   User?     @relation("ControlOp", fields: [controlOpId], references: [id])
  notes       String?
  checkIns    CheckIn[]
}

model CheckIn {
  id            String     @id @default(cuid())
  sessionId     String
  session       NetSession @relation(fields: [sessionId], references: [id])
  userId        String?                    // null for visitors
  user          User?      @relation(fields: [userId], references: [id])
  callsign      String                     // denormalized for audit trail
  nameAtCheckIn String
  checkedInAt   DateTime   @default(now())
  comment       String?
  @@index([sessionId])
  @@index([callsign])
}

enum Role { MEMBER OFFICER ADMIN }
```

**Key decisions:**

- **Callsign denormalized on `CheckIn`** so historical logs survive user deletion (FCC-friendly audit trail).
- **`NetSession` separate from `Net`** — Net is the recurring schedule, NetSession is one instance. Stats query against sessions.
- **Visitors allowed** — `CheckIn.userId` is nullable so non-member guests still get logged by callsign and name.
- **`scriptMd`** on Net is a user-authored markdown script. No auto-generation in v1. Officers can edit during a session if they want variation.

## Theme System

One picker in Settings switches colors, fonts, and a logo slot. Themes live as folders under `themes/` and are auto-registered at build time via Vite `import.meta.glob('./*/theme.json')`. Adding a school = drop a folder, no code changes.

### Folder shape

```
themes/
├── index.ts                    # exported registry
├── default/
│   ├── theme.json
│   └── logo.svg                # neutral ham radio icon (original art)
├── kstate/
│   ├── theme.json
│   └── logo.svg                # empty placeholder, replaced locally
├── mit/
├── georgiatech/
├── virginiatech/
└── illinois/
```

### `theme.json` schema

```json
{
  "slug": "kstate",
  "name": "Kansas State University",
  "shortName": "K-State",
  "colors": {
    "primary":   "#512888",
    "primaryFg": "#FFFFFF",
    "accent":    "#A7A9AC",
    "bg":        "#FFFFFF",
    "bgMuted":   "#F4F1F8",
    "fg":        "#1C1C1C",
    "border":    "#D4C9E2",
    "success":   "#2E7D32",
    "danger":    "#C62828"
  },
  "font": {
    "display": "'Inter', system-ui, sans-serif",
    "body":    "'Inter', system-ui, sans-serif"
  },
  "logo": {
    "file": "logo.svg",
    "alt":  "K-State Powercat",
    "maxHeightPx": 64
  },
  "attribution": "Colors per K-State brand guide. Logo not included — drop your own with permission."
}
```

### How it applies

- Each theme's colors are written to **CSS custom properties on `:root`** (`--color-primary`, `--color-bg`, ...). All components read these vars.
- Switching a theme sets `document.documentElement.dataset.theme = slug` and rewrites the CSS var block — no component re-render needed.
- **Theme picker** lives in Settings. Persisted per-user in `User.collegeSlug`; unauthenticated visitors use `localStorage`.
- **Logo slot:** if `logo.svg` is missing or empty, the app renders a neutral ham-radio icon plus `shortName` text. This keeps the repo publishable without trademarked assets.

### Trademark handling

**Trademarked college logos (Powercat, MIT seal, GT Buzz, etc.) are NOT shipped in the repo.** Each theme folder contains only colors, fonts, and an empty `logo.svg` slot. A `themes/README.md` explains that clubs must provide their own logo with proper permission from their university. This protects the public repo from takedown requests.

### v1 themes shipped

- `default` — neutral purple/slate, original ham-radio mark (ships with real logo)
- `kstate` — K-State purple `#512888`
- `mit` — MIT red `#A31F34`
- `georgiatech` — GT gold `#B3A369` + navy `#003057`
- `virginiatech` — VT maroon `#630031` + burnt orange `#CF4420`
- `illinois` — Illinois orange `#E84A27` + blue `#13294B`

## Auth

- **Email + password**, passwords hashed with **argon2**.
- **JWT in httpOnly cookie**, `SameSite=Lax`, 7-day expiry, sliding refresh on activity.
- **Roles:** `MEMBER` (check in, view), `OFFICER` (CRUD nets/repeaters, run sessions), `ADMIN` (manage users, promote officers). First user to register becomes `ADMIN`.
- **Registration gate:** optional invite code env var `REGISTRATION_CODE`. Empty = open, set = required. Simple way to keep randos out without building a full invite system.
- **Callsign validation:** regex `^[A-Z0-9]{3,7}$` on save. No FCC ULS lookup in v1.

## API Surface

All routes under `/api`, all request bodies Zod-validated using schemas from `packages/shared`.

```
POST   /auth/register          { email, password, name, callsign, inviteCode? }
POST   /auth/login             { email, password }        → sets cookie
POST   /auth/logout
GET    /auth/me                → current user or 401

GET    /repeaters
POST   /repeaters              [OFFICER]
PATCH  /repeaters/:id          [OFFICER]
DELETE /repeaters/:id          [OFFICER]

GET    /nets
POST   /nets                   [OFFICER]
PATCH  /nets/:id               [OFFICER]
DELETE /nets/:id               [OFFICER]

POST   /nets/:id/sessions      [OFFICER]  → start a session
PATCH  /sessions/:id           [OFFICER]  → end session, notes
GET    /sessions/:id                      → session + checkins
GET    /sessions?netId=&from=&to=         → list for stats

POST   /sessions/:id/checkins  [any authenticated user]
DELETE /checkins/:id           [OFFICER, or the creator within 5 min]

GET    /stats/participation?from=&to=     → per-member + per-net counts
GET    /stats/export.csv                  → CSV download
GET    /stats/export.pdf                  → PDF (server-rendered, theme-aware)

GET    /themes                 → public registry, no auth
PATCH  /users/me               → { collegeSlug, name, ... }
GET    /users                  [ADMIN]
PATCH  /users/:id/role         [ADMIN]
```

### Error shape

Every error returns `{ error: { code: string, message: string, details?: unknown } }` with the appropriate HTTP status. Frontend has one `apiFetch()` wrapper that throws typed errors.

## Frontend Structure

```
apps/web/src/
├── main.tsx
├── App.tsx                    # Router + ThemeProvider + AuthProvider
├── theme/
│   ├── ThemeProvider.tsx      # sets CSS vars on :root, syncs to user
│   └── ThemePicker.tsx        # dropdown with swatches + logo preview
├── auth/
│   ├── AuthProvider.tsx       # Zustand store + /auth/me bootstrap
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   └── RequireRole.tsx        # route guard
├── pages/
│   ├── Dashboard.tsx          # next net countdown, recent sessions
│   ├── RepeatersPage.tsx      # list + add/edit modal
│   ├── NetsPage.tsx           # schedule + script editor
│   ├── RunNetPage.tsx         # ⭐ live check-in view
│   ├── StatsPage.tsx          # charts + CSV/PDF export buttons
│   ├── SettingsPage.tsx       # profile, theme, password
│   └── AdminPage.tsx          # user management
├── components/
│   ├── ui/                    # Button, Input, Modal, Card — all theme-var driven
│   ├── CallsignInput.tsx      # auto-uppercase, regex validation
│   ├── RepeaterCard.tsx
│   └── ScriptEditor.tsx       # markdown textarea + preview
├── api/
│   └── client.ts              # apiFetch wrapper, typed via shared schemas
└── lib/
    ├── time.ts                # tz-aware "next occurrence of Net" helper
    └── format.ts              # frequency formatting, tone display
```

## Net-Running Flow (the centerpiece)

1. **Officer clicks "Start Net"** on the Nets page → `POST /nets/:id/sessions` → redirect to `/run/:sessionId`.
2. **RunNetPage layout:**
   - Left: large repeater info header (frequency, offset, tone, mode).
   - Center: current script (markdown rendered, scrollable, editable inline per session).
   - Right: running check-in list — most recent at top, count at bottom.
   - Bottom: callsign input with autocomplete over known members. Enter adds a check-in, clears field, keeps focus. Backspace on empty offers undo of last check-in.
3. **Visitor check-ins:** if the typed callsign doesn't match a member, prompt "Log as visitor?" → creates a `CheckIn` with `userId=null`, storing denormalized callsign and typed name.
4. **End Net:** officer clicks "End Net" → `PATCH /sessions/:id` with `endedAt` plus optional notes → redirect to a session summary view with "Export sign-in CSV" and "Copy log to clipboard" buttons.
5. **Keyboard-first:** the entire flow is usable without a mouse — Tab moves between callsign input, script, and undo; Esc ends net with confirm.

## Stats & Exports

- **On-screen dashboard:** bar chart of check-ins per net over a selectable date range (Recharts); leaderboard of top-10 members by session count.
- **CSV export:** streamed from the server, one row per check-in (date, session, callsign, name, comment).
- **PDF export:** server-rendered via `@react-pdf/renderer`. Cover page with theme colors + logo (whatever the requesting user's college slug is), summary table, per-net breakdown. Suitable as an attachment to funding requests.

## Testing Strategy

- **`packages/shared`:** Vitest unit tests on every Zod schema (happy and unhappy paths).
- **`apps/api`:** Vitest + Supertest hitting a real SQLite file in `:memory:` mode. One test per route covering: unauthenticated, wrong role, happy path, validation error. Prisma migrations run in a `beforeAll` setup.
- **`apps/web`:** Vitest + React Testing Library for components with logic (`CallsignInput`, `ThemePicker`, `RunNetPage` reducer). No snapshot tests.
- **CI:** GitHub Actions matrix running `lint`, `typecheck`, `test:shared`, `test:api`, `test:web`, `build`, `docker build`. Same pattern as the YouTube Clicker repo.
- **No E2E in v1.** Playwright is deferred to v2; not worth the CI time until the core flow stabilizes.

## Out of Scope for v1

- Auto-generating net scripts (user enters their own).
- FCC ULS lookup / automatic callsign verification.
- Auto-shipping trademarked college logos.
- Playwright E2E tests.
- Mobile-native app (web is mobile-responsive, but no React Native / PWA install flow).
- Multi-club / multi-tenancy. One deployment = one club.
- Email notifications / net reminders.
- Real-time websocket sync between multiple control operators (one-op-at-a-time in v1).

## Success Criteria

- A club officer can: register, log in, add a repeater, schedule a weekly net with script, start a session, check in ~20 members in under 5 minutes with keyboard only, end the session, and export a CSV sign-in log.
- A member can: register, log in, pick their college theme, view upcoming nets and past check-in history.
- An admin can: promote a member to officer.
- `docker build` produces a single image that runs with one `docker run -v data:/data -p 3000:3000` command.
- All CI jobs pass on GitHub Actions.
- `themes/kstate/` can be swapped in and visually applied across the app by clicking a single picker item.
