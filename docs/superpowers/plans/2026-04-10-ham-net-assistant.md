# Ham-Net-Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web app for college amateur-radio clubs to manage repeaters, schedule weekly nets, run live check-ins, produce FCC-friendly sign-in logs and participation stats, with pickable college themes.

**Architecture:** npm-workspaces monorepo. `apps/web` (Vite + React 18 + TS) and `apps/api` (Express + TS + Prisma + SQLite) share Zod schemas from `packages/shared`. A multi-stage Dockerfile builds the frontend, copies its dist into the API server, and serves `/api/*` plus the SPA on one port. Themes live as folders under `themes/` with colors-only JSON and empty logo slots (trademark-safe).

**Tech Stack:** Node 20 · TypeScript (strict) · React 18 · Vite 5 · Zustand · React Router · Express · Prisma · SQLite · Zod · argon2 · jsonwebtoken · Vitest · Supertest · Recharts · @react-pdf/renderer · Docker · GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-04-10-ham-net-assistant-design.md`

---

## File Structure

```
ham-net-assistant/
├── package.json                    # npm workspaces root
├── tsconfig.base.json              # shared TS config
├── .eslintrc.cjs                   # shared lint config
├── .prettierrc.json
├── .gitignore
├── README.md
├── docker/
│   └── Dockerfile                  # multi-stage
├── docker-compose.yml
├── .github/workflows/ci.yml
├── packages/
│   └── shared/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── auth.ts             # auth Zod schemas
│       │   ├── repeater.ts
│       │   ├── net.ts
│       │   ├── session.ts
│       │   ├── checkin.ts
│       │   ├── stats.ts
│       │   ├── user.ts
│       │   └── errors.ts
│       └── test/
│           └── schemas.test.ts
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   ├── src/
│   │   │   ├── index.ts            # express bootstrap
│   │   │   ├── app.ts              # buildApp factory
│   │   │   ├── env.ts              # env var parsing
│   │   │   ├── db.ts               # prisma client singleton
│   │   │   ├── static.ts           # SPA fallback
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── validate.ts
│   │   │   │   └── error.ts
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── repeaters.ts
│   │   │   │   ├── nets.ts
│   │   │   │   ├── sessions.ts
│   │   │   │   ├── checkins.ts
│   │   │   │   ├── stats.ts
│   │   │   │   ├── themes.ts
│   │   │   │   └── users.ts
│   │   │   └── lib/
│   │   │       ├── password.ts
│   │   │       ├── jwt.ts
│   │   │       ├── csv.ts
│   │   │       └── pdf.tsx
│   │   └── test/
│   │       ├── helpers.ts
│   │       └── routes/
│   │           ├── auth.test.ts
│   │           ├── repeaters.test.ts
│   │           ├── nets.test.ts
│   │           ├── sessions.test.ts
│   │           ├── checkins.test.ts
│   │           ├── stats.test.ts
│   │           ├── themes.test.ts
│   │           └── users.test.ts
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── test-setup.ts
│           ├── styles/
│           │   ├── reset.css
│           │   └── theme-vars.css
│           ├── theme/
│           │   ├── ThemeProvider.tsx
│           │   ├── ThemePicker.tsx
│           │   └── registry.ts
│           ├── auth/
│           │   ├── AuthProvider.tsx
│           │   ├── LoginPage.tsx
│           │   ├── RegisterPage.tsx
│           │   └── RequireRole.tsx
│           ├── pages/
│           │   ├── Dashboard.tsx
│           │   ├── RepeatersPage.tsx
│           │   ├── NetsPage.tsx
│           │   ├── RunNetPage.tsx
│           │   ├── StatsPage.tsx
│           │   ├── SettingsPage.tsx
│           │   └── AdminPage.tsx
│           ├── components/
│           │   ├── ui/
│           │   │   ├── Button.tsx
│           │   │   ├── Input.tsx
│           │   │   ├── Modal.tsx
│           │   │   ├── Card.tsx
│           │   │   └── ui.css
│           │   ├── CallsignInput.tsx
│           │   ├── CallsignInput.test.tsx
│           │   ├── RepeaterCard.tsx
│           │   └── ScriptEditor.tsx
│           ├── api/
│           │   └── client.ts
│           └── lib/
│               ├── time.ts
│               └── format.ts
└── themes/
    ├── README.md
    ├── default/{theme.json,logo.svg}
    ├── kstate/{theme.json,logo.svg}
    ├── mit/{theme.json,logo.svg}
    ├── georgiatech/{theme.json,logo.svg}
    ├── virginiatech/{theme.json,logo.svg}
    └── illinois/{theme.json,logo.svg}
```

**Decomposition notes:**
- Each route file owns one resource, mirrored by one test file.
- `packages/shared` is a pure Zod package — no Express or React imports. Both apps depend on it.
- `themes/` lives at the repo root so both web (bundles via Vite glob) and api (fs-reads for `/api/themes`) can access it.
- Each file stays small. Route files > 200 lines get split.

---

## Task 1: Monorepo scaffold + tooling

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc.json`, `.gitignore`, `README.md`

- [ ] **Step 1.1: Create `.gitignore`**

```
node_modules/
dist/
build/
coverage/
.env
.env.local
*.log
.DS_Store
apps/api/prisma/dev.db*
data/
```

- [ ] **Step 1.2: Create root `package.json`**

```json
{
  "name": "ham-net-assistant",
  "private": true,
  "version": "0.1.0",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "dev:api": "npm -w @hna/api run dev",
    "dev:web": "npm -w @hna/web run dev",
    "build": "npm -w @hna/shared run build && npm -w @hna/api run build && npm -w @hna/web run build",
    "test": "npm -w @hna/shared run test && npm -w @hna/api run test && npm -w @hna/web run test",
    "typecheck": "npm -w @hna/shared run typecheck && npm -w @hna/api run typecheck && npm -w @hna/web run typecheck",
    "lint": "eslint . --ext .ts,.tsx"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "eslint": "^8.57.0",
    "@typescript-eslint/parser": "^7.7.0",
    "@typescript-eslint/eslint-plugin": "^7.7.0",
    "prettier": "^3.2.5",
    "eslint-config-prettier": "^9.1.0"
  }
}
```

- [ ] **Step 1.3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  }
}
```

- [ ] **Step 1.4: Create `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: ['dist', 'build', 'coverage', 'node_modules'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
  }
};
```

- [ ] **Step 1.5: Create `.prettierrc.json`**

```json
{ "singleQuote": true, "semi": true, "trailingComma": "all", "printWidth": 100 }
```

- [ ] **Step 1.6: Create minimal `README.md`**

```markdown
# Ham-Net-Assistant

Club repeater & net assistant for college amateur-radio clubs.

## Dev

    npm install
    npm run dev:api   # in one terminal
    npm run dev:web   # in another

## Test

    npm test

## Build

    npm run build

See `docs/superpowers/specs/` for the design.
```

- [ ] **Step 1.7: Install root deps and commit**

```bash
npm install
git add .
git commit -m "chore: monorepo scaffold with workspaces and lint config"
```

---

## Task 2: Shared package — Zod schemas

**Files:**
- Create: `packages/shared/package.json`, `tsconfig.json`, `src/*.ts`, `test/schemas.test.ts`

- [ ] **Step 2.1: Create `packages/shared/package.json`**

```json
{
  "name": "@hna/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.23.4" },
  "devDependencies": { "vitest": "^1.5.0" }
}
```

- [ ] **Step 2.2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2.3: Create `src/errors.ts`**

```ts
import { z } from 'zod';

export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'CONFLICT',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
```

- [ ] **Step 2.4: Create `src/auth.ts`**

```ts
import { z } from 'zod';

export const Callsign = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{3,7}$/, 'Callsign must be 3–7 letters/digits');

export const Role = z.enum(['MEMBER', 'OFFICER', 'ADMIN']);
export type Role = z.infer<typeof Role>;

export const RegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80),
  callsign: Callsign,
  inviteCode: z.string().optional(),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const PublicUser = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  callsign: Callsign,
  role: Role,
  collegeSlug: z.string().nullable(),
});
export type PublicUser = z.infer<typeof PublicUser>;
```

- [ ] **Step 2.5: Create `src/repeater.ts`**

```ts
import { z } from 'zod';

export const RepeaterMode = z.enum(['FM', 'DMR', 'D-STAR', 'Fusion']);

export const RepeaterInput = z.object({
  name: z.string().min(1).max(120),
  frequency: z.number().positive().max(2000),
  offsetKhz: z.number().int().gte(-10000).lte(10000),
  toneHz: z.number().positive().nullable().optional(),
  mode: RepeaterMode,
  coverage: z.string().max(1000).nullable().optional(),
  latitude: z.number().gte(-90).lte(90).nullable().optional(),
  longitude: z.number().gte(-180).lte(180).nullable().optional(),
});
export type RepeaterInput = z.infer<typeof RepeaterInput>;

export const Repeater = RepeaterInput.extend({
  id: z.string(),
  createdAt: z.string().datetime(),
});
export type Repeater = z.infer<typeof Repeater>;
```

- [ ] **Step 2.6: Create `src/net.ts`**

```ts
import { z } from 'zod';

export const NetInput = z.object({
  name: z.string().min(1).max(120),
  repeaterId: z.string().min(1),
  dayOfWeek: z.number().int().gte(0).lte(6),
  startLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm'),
  timezone: z.string().min(1),
  theme: z.string().max(200).nullable().optional(),
  scriptMd: z.string().max(20000).nullable().optional(),
  active: z.boolean().optional(),
});
export type NetInput = z.infer<typeof NetInput>;

export const Net = NetInput.extend({
  id: z.string(),
  active: z.boolean(),
});
export type Net = z.infer<typeof Net>;
```

- [ ] **Step 2.7: Create `src/session.ts`**

```ts
import { z } from 'zod';

export const NetSessionUpdate = z.object({
  endedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
export type NetSessionUpdate = z.infer<typeof NetSessionUpdate>;

export const NetSession = z.object({
  id: z.string(),
  netId: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  controlOpId: z.string().nullable(),
  notes: z.string().nullable(),
});
export type NetSession = z.infer<typeof NetSession>;
```

- [ ] **Step 2.8: Create `src/checkin.ts`**

```ts
import { z } from 'zod';
import { Callsign } from './auth.js';

export const CheckInInput = z.object({
  callsign: Callsign,
  nameAtCheckIn: z.string().min(1).max(80),
  comment: z.string().max(500).nullable().optional(),
});
export type CheckInInput = z.infer<typeof CheckInInput>;

export const CheckIn = z.object({
  id: z.string(),
  sessionId: z.string(),
  userId: z.string().nullable(),
  callsign: Callsign,
  nameAtCheckIn: z.string(),
  checkedInAt: z.string().datetime(),
  comment: z.string().nullable(),
});
export type CheckIn = z.infer<typeof CheckIn>;
```

- [ ] **Step 2.9: Create `src/stats.ts`**

```ts
import { z } from 'zod';

export const StatsQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type StatsQuery = z.infer<typeof StatsQuery>;

export const ParticipationStats = z.object({
  range: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
  totalSessions: z.number().int(),
  totalCheckIns: z.number().int(),
  perMember: z.array(
    z.object({ callsign: z.string(), name: z.string(), count: z.number().int() }),
  ),
  perNet: z.array(
    z.object({ netId: z.string(), netName: z.string(), sessions: z.number().int(), checkIns: z.number().int() }),
  ),
});
export type ParticipationStats = z.infer<typeof ParticipationStats>;
```

- [ ] **Step 2.10: Create `src/user.ts`**

```ts
import { z } from 'zod';
import { Role } from './auth.js';

export const UpdateMeInput = z.object({
  name: z.string().min(1).max(80).optional(),
  collegeSlug: z.string().max(40).nullable().optional(),
});
export type UpdateMeInput = z.infer<typeof UpdateMeInput>;

export const UpdateRoleInput = z.object({ role: Role });
export type UpdateRoleInput = z.infer<typeof UpdateRoleInput>;
```

- [ ] **Step 2.11: Create `src/index.ts`**

```ts
export * from './errors.js';
export * from './auth.js';
export * from './repeater.js';
export * from './net.js';
export * from './session.js';
export * from './checkin.js';
export * from './stats.js';
export * from './user.js';
```

- [ ] **Step 2.12: Write schema tests (`test/schemas.test.ts`)**

```ts
import { describe, it, expect } from 'vitest';
import {
  Callsign, RegisterInput, RepeaterInput, NetInput, CheckInInput,
} from '../src/index.js';

describe('Callsign', () => {
  it('accepts valid callsigns and uppercases', () => {
    expect(Callsign.parse('kd0xyz')).toBe('KD0XYZ');
  });
  it('rejects too-short', () => {
    expect(() => Callsign.parse('K1')).toThrow();
  });
  it('rejects symbols', () => {
    expect(() => Callsign.parse('W1-ABC')).toThrow();
  });
});

describe('RegisterInput', () => {
  it('accepts complete input', () => {
    const out = RegisterInput.parse({
      email: 'a@b.co', password: 'longenough', name: 'Alice', callsign: 'W1AW',
    });
    expect(out.callsign).toBe('W1AW');
  });
  it('rejects short password', () => {
    expect(() =>
      RegisterInput.parse({ email: 'a@b.co', password: '1', name: 'A', callsign: 'W1AW' }),
    ).toThrow();
  });
});

describe('RepeaterInput', () => {
  it('accepts valid', () => {
    expect(
      RepeaterInput.parse({ name: 'KSU', frequency: 146.76, offsetKhz: -600, mode: 'FM' }).frequency,
    ).toBe(146.76);
  });
  it('rejects bad mode', () => {
    expect(() =>
      RepeaterInput.parse({ name: 'x', frequency: 1, offsetKhz: 0, mode: 'AM' as never }),
    ).toThrow();
  });
});

describe('NetInput', () => {
  it('accepts HH:mm', () => {
    expect(
      NetInput.parse({
        name: 'Wed Net', repeaterId: 'x', dayOfWeek: 3, startLocal: '20:00',
        timezone: 'America/Chicago',
      }).startLocal,
    ).toBe('20:00');
  });
  it('rejects bad time', () => {
    expect(() =>
      NetInput.parse({
        name: 'x', repeaterId: 'y', dayOfWeek: 3, startLocal: '25:00', timezone: 'UTC',
      }),
    ).toThrow();
  });
});

describe('CheckInInput', () => {
  it('uppercases callsign', () => {
    expect(CheckInInput.parse({ callsign: 'w1aw', nameAtCheckIn: 'Alice' }).callsign).toBe('W1AW');
  });
});
```

- [ ] **Step 2.13: Run tests — expect PASS**

```bash
cd packages/shared && npm install && npm test
```
Expected: all schema tests pass.

- [ ] **Step 2.14: Build and typecheck**

```bash
npm run build && npm run typecheck
```
Expected: `dist/` populated, no errors.

- [ ] **Step 2.15: Commit**

```bash
git add packages/shared package-lock.json
git commit -m "feat(shared): Zod schemas for auth, repeaters, nets, sessions, checkins, stats"
```

---

## Task 3: API — package, Prisma schema, env, db

**Files:**
- Create: `apps/api/package.json`, `tsconfig.json`, `prisma/schema.prisma`, `src/env.ts`, `src/db.ts`, `.env.example`

- [ ] **Step 3.1: Create `apps/api/package.json`**

```json
{
  "name": "@hna/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:deploy": "prisma migrate deploy"
  },
  "dependencies": {
    "@hna/shared": "*",
    "@prisma/client": "^5.13.0",
    "express": "^4.19.2",
    "cookie-parser": "^1.4.6",
    "cors": "^2.8.5",
    "argon2": "^0.40.1",
    "jsonwebtoken": "^9.0.2",
    "zod": "^3.23.4",
    "@react-pdf/renderer": "^3.4.0",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/cookie-parser": "^1.4.7",
    "@types/cors": "^2.8.17",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/node": "^20.12.7",
    "@types/supertest": "^6.0.2",
    "@types/react": "^18.3.1",
    "prisma": "^5.13.0",
    "supertest": "^7.0.0",
    "tsx": "^4.7.2",
    "typescript": "^5.4.5",
    "vitest": "^1.5.0"
  }
}
```

- [ ] **Step 3.2: Create `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3.3: Create `apps/api/.env.example`**

```
DATABASE_URL="file:./dev.db"
JWT_SECRET="change-me-to-a-long-random-string"
REGISTRATION_CODE=""
PORT=3000
NODE_ENV=development
STATIC_DIR=""
```

- [ ] **Step 3.4: Create `apps/api/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

enum Role {
  MEMBER
  OFFICER
  ADMIN
}

model User {
  id                 String       @id @default(cuid())
  callsign           String       @unique
  name               String
  email              String       @unique
  passwordHash       String
  role               Role         @default(MEMBER)
  collegeSlug        String?
  createdAt          DateTime     @default(now())
  checkIns           CheckIn[]
  controlledSessions NetSession[] @relation("ControlOp")
}

model Repeater {
  id         String   @id @default(cuid())
  name       String
  frequency  Float
  offsetKhz  Int
  toneHz     Float?
  mode       String
  coverage   String?
  latitude   Float?
  longitude  Float?
  createdAt  DateTime @default(now())
  nets       Net[]
}

model Net {
  id         String       @id @default(cuid())
  name       String
  repeaterId String
  repeater   Repeater     @relation(fields: [repeaterId], references: [id])
  dayOfWeek  Int
  startLocal String
  timezone   String
  theme      String?
  scriptMd   String?
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
  userId        String?
  user          User?      @relation(fields: [userId], references: [id])
  callsign      String
  nameAtCheckIn String
  checkedInAt   DateTime   @default(now())
  comment       String?

  @@index([sessionId])
  @@index([callsign])
}
```

- [ ] **Step 3.5: Create `src/env.ts`**

```ts
import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().default('file:./dev.db'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be >= 16 chars'),
  REGISTRATION_CODE: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  STATIC_DIR: z.string().default(''),
});

export const env = Env.parse(process.env);
```

- [ ] **Step 3.6: Create `src/db.ts`**

```ts
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
```

- [ ] **Step 3.7: Install and generate**

```bash
cd apps/api
npm install
npx prisma generate
npx prisma migrate dev --name init
```
Expected: `prisma/migrations/*/migration.sql` created and `dev.db` generated.

- [ ] **Step 3.8: Commit**

```bash
cd ../..
git add apps/api package-lock.json
git commit -m "feat(api): package scaffold, prisma schema, env parser, db client"
```

---

## Task 4: API — password/jwt lib + auth middleware + test helpers

**Files:**
- Create: `src/lib/password.ts`, `src/lib/jwt.ts`, `src/middleware/auth.ts`, `src/middleware/validate.ts`, `src/middleware/error.ts`, `test/helpers.ts`

- [ ] **Step 4.1: Create `src/lib/password.ts`**

```ts
import argon2 from 'argon2';

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
```

- [ ] **Step 4.2: Create `src/lib/jwt.ts`**

```ts
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import type { Role } from '@hna/shared';

export interface JwtClaims {
  sub: string;
  role: Role;
}

const DAYS = 60 * 60 * 24;

export function signToken(claims: JwtClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: 7 * DAYS });
}

export function verifyToken(token: string): JwtClaims {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded === 'string') throw new Error('Invalid token');
  return { sub: String(decoded.sub), role: decoded.role as Role };
}

export const COOKIE_NAME = 'hna_session';
export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  maxAge: 7 * DAYS * 1000,
  path: '/',
};
```

- [ ] **Step 4.3: Create `src/middleware/error.ts`**

```ts
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ErrorCode } from '@hna/shared';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION', message: 'Invalid request', details: err.flatten() },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
};
```

- [ ] **Step 4.4: Create `src/middleware/validate.ts`**

```ts
import type { RequestHandler } from 'express';
import type { ZodSchema } from 'zod';

export function validateBody<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.parse(req.body);
    req.body = parsed;
    next();
  };
}
```

- [ ] **Step 4.5: Create `src/middleware/auth.ts`**

```ts
import type { Request, RequestHandler } from 'express';
import type { Role } from '@hna/shared';
import { verifyToken, COOKIE_NAME } from '../lib/jwt.js';
import { HttpError } from './error.js';

export interface AuthUser {
  id: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export const loadUser: RequestHandler = (req, _res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      const claims = verifyToken(token);
      req.user = { id: claims.sub, role: claims.role };
    } catch {
      /* invalid token → anonymous */
    }
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
  next();
};

const ORDER: Record<Role, number> = { MEMBER: 0, OFFICER: 1, ADMIN: 2 };

export function requireRole(min: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
    if (ORDER[req.user.role] < ORDER[min]) {
      throw new HttpError(403, 'FORBIDDEN', `Requires ${min} role`);
    }
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
  return req.user;
}
```

- [ ] **Step 4.6: Create `test/helpers.ts`**

Note: uses `execFileSync` (not `execSync`) to avoid shell injection warnings. All args are literals — safe, but `execFile` is cleaner anyway.

```ts
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';

process.env.JWT_SECRET = 'test-secret-long-enough-for-validation';
process.env.NODE_ENV = 'test';

export function makeTestDb(): { prisma: PrismaClient; dbFile: string } {
  const dbFile = path.join(
    process.cwd(),
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  process.env.DATABASE_URL = `file:${dbFile}`;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${dbFile}` } },
  });
  return { prisma, dbFile };
}

export async function cleanupTestDb(prisma: PrismaClient, dbFile: string): Promise<void> {
  await prisma.$disconnect();
  try { fs.unlinkSync(dbFile); } catch { /* ignore */ }
  try { fs.unlinkSync(`${dbFile}-journal`); } catch { /* ignore */ }
}

export async function makeTestApp(): Promise<{
  app: Express;
  prisma: PrismaClient;
  dbFile: string;
}> {
  const { prisma, dbFile } = makeTestDb();
  const { buildApp } = await import('../src/app.js');
  const app = buildApp(prisma);
  return { app, prisma, dbFile };
}
```

- [ ] **Step 4.7: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): password/jwt lib, auth+validate+error middleware, test helpers"
```

---

## Task 5: API — app factory + auth routes (TDD)

**Files:**
- Create: `src/app.ts`, `src/index.ts`, `src/routes/auth.ts`, `test/routes/auth.test.ts`

- [ ] **Step 5.1: Create failing test `test/routes/auth.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express;
let prisma: PrismaClient;
let dbFile: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});

describe('POST /api/auth/register', () => {
  it('creates first user as ADMIN and sets cookie', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com', password: 'hunter2hunter2',
      name: 'Alice', callsign: 'w1aw',
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('ADMIN');
    expect(res.body.callsign).toBe('W1AW');
    expect(res.headers['set-cookie']?.[0]).toMatch(/hna_session=/);
  });

  it('makes second user MEMBER', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'bob@example.com', password: 'hunter2hunter2',
      name: 'Bob', callsign: 'KB0BOB',
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('MEMBER');
  });

  it('rejects duplicate email', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com', password: 'hunter2hunter2',
      name: 'Alice2', callsign: 'KC0XYZ',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects invalid callsign', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'charlie@example.com', password: 'hunter2hunter2',
      name: 'Chuck', callsign: 'X',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});

describe('POST /api/auth/login + /me + /logout', () => {
  it('logs in, returns user from /me, logs out', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({
      email: 'alice@example.com', password: 'hunter2hunter2',
    });
    expect(login.status).toBe(200);
    expect(login.body.email).toBe('alice@example.com');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.callsign).toBe('W1AW');

    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(204);

    const me2 = await agent.get('/api/auth/me');
    expect(me2.status).toBe(401);
  });

  it('rejects bad password', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com', password: 'wrongwrongwrong',
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 5.2: Create `src/routes/auth.ts`**

```ts
import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { RegisterInput, LoginInput, PublicUser } from '@hna/shared';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken, COOKIE_NAME, COOKIE_OPTS } from '../lib/jwt.js';
import { env } from '../env.js';
import { HttpError } from '../middleware/error.js';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';

export function authRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post('/register', validateBody(RegisterInput), async (req, res) => {
    const input = req.body as typeof RegisterInput._type;
    if (env.REGISTRATION_CODE && input.inviteCode !== env.REGISTRATION_CODE) {
      throw new HttpError(403, 'FORBIDDEN', 'Invalid invite code');
    }
    const count = await prisma.user.count();
    const role = count === 0 ? 'ADMIN' : 'MEMBER';
    const passwordHash = await hashPassword(input.password);
    try {
      const user = await prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          callsign: input.callsign,
          passwordHash,
          role,
        },
      });
      const token = signToken({ sub: user.id, role: user.role });
      res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
      res.status(201).json(PublicUser.parse(toPublic(user)));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new HttpError(409, 'CONFLICT', 'Email or callsign already in use');
      }
      throw e;
    }
  });

  router.post('/login', validateBody(LoginInput), async (req, res) => {
    const input = req.body as typeof LoginInput._type;
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid credentials');
    }
    const token = signToken({ sub: user.id, role: user.role });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json(PublicUser.parse(toPublic(user)));
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: 0 });
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'User no longer exists');
    res.json(PublicUser.parse(toPublic(user)));
  });

  return router;
}

function toPublic(u: {
  id: string; email: string; name: string; callsign: string;
  role: 'MEMBER' | 'OFFICER' | 'ADMIN'; collegeSlug: string | null;
}) {
  return {
    id: u.id, email: u.email, name: u.name, callsign: u.callsign,
    role: u.role, collegeSlug: u.collegeSlug,
  };
}
```

- [ ] **Step 5.3: Create `src/app.ts`**

```ts
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { loadUser } from './middleware/auth.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';

export function buildApp(prisma: PrismaClient): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(loadUser);

  app.use('/api/auth', authRouter(prisma));

  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 5.4: Create `src/index.ts`**

```ts
import { buildApp } from './app.js';
import { prisma } from './db.js';
import { env } from './env.js';

const app = buildApp(prisma);
app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Ham-Net-Assistant API listening on :${env.PORT}`);
});
```

- [ ] **Step 5.5: Run auth tests — expect PASS**

```bash
cd apps/api && npm test -- test/routes/auth.test.ts
```

- [ ] **Step 5.6: Commit**

```bash
cd ../..
git add apps/api
git commit -m "feat(api): auth routes (register/login/logout/me) with argon2 + JWT cookie"
```

---

## Task 6: API — repeaters CRUD (TDD)

**Files:**
- Create: `src/routes/repeaters.ts`, `test/routes/repeaters.test.ts`
- Modify: `src/app.ts` (mount router)

- [ ] **Step 6.1: Write failing tests `test/routes/repeaters.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officerCookie: string; let memberCookie: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officerCookie = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co', password: 'hunter2hunter2', name: 'M', callsign: 'KB0BOB',
  });
  memberCookie = m.headers['set-cookie'][0];
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => { await prisma.repeater.deleteMany(); });

const valid = {
  name: 'KSU Main', frequency: 146.76, offsetKhz: -600,
  toneHz: 91.5, mode: 'FM', coverage: 'Manhattan, KS',
};

describe('GET /api/repeaters (public)', () => {
  it('lists repeaters without auth', async () => {
    await request(app).post('/api/repeaters').set('Cookie', officerCookie).send(valid);
    const res = await request(app).get('/api/repeaters');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].frequency).toBe(146.76);
  });
});

describe('POST /api/repeaters', () => {
  it('rejects unauthenticated', async () => {
    const res = await request(app).post('/api/repeaters').send(valid);
    expect(res.status).toBe(401);
  });
  it('rejects MEMBER', async () => {
    const res = await request(app).post('/api/repeaters').set('Cookie', memberCookie).send(valid);
    expect(res.status).toBe(403);
  });
  it('creates as OFFICER+', async () => {
    const res = await request(app).post('/api/repeaters').set('Cookie', officerCookie).send(valid);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('KSU Main');
  });
  it('validates input', async () => {
    const res = await request(app)
      .post('/api/repeaters').set('Cookie', officerCookie)
      .send({ ...valid, frequency: -1 });
    expect(res.status).toBe(400);
  });
});

describe('PATCH/DELETE /api/repeaters/:id', () => {
  it('updates and deletes as officer', async () => {
    const c = await request(app).post('/api/repeaters').set('Cookie', officerCookie).send(valid);
    const id = c.body.id;
    const u = await request(app)
      .patch(`/api/repeaters/${id}`).set('Cookie', officerCookie)
      .send({ ...valid, name: 'KSU Renamed' });
    expect(u.status).toBe(200);
    expect(u.body.name).toBe('KSU Renamed');
    const d = await request(app).delete(`/api/repeaters/${id}`).set('Cookie', officerCookie);
    expect(d.status).toBe(204);
    const g = await request(app).get('/api/repeaters');
    expect(g.body).toHaveLength(0);
  });
  it('404s unknown id', async () => {
    const res = await request(app)
      .patch('/api/repeaters/nope').set('Cookie', officerCookie).send(valid);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 6.2: Create `src/routes/repeaters.ts`**

```ts
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { RepeaterInput } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';

export function repeatersRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const list = await prisma.repeater.findMany({ orderBy: { name: 'asc' } });
    res.json(list);
  });

  router.post('/', requireRole('OFFICER'), validateBody(RepeaterInput), async (req, res) => {
    const created = await prisma.repeater.create({ data: req.body });
    res.status(201).json(created);
  });

  router.patch('/:id', requireRole('OFFICER'), validateBody(RepeaterInput), async (req, res) => {
    try {
      const updated = await prisma.repeater.update({
        where: { id: req.params.id },
        data: req.body,
      });
      res.json(updated);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Repeater not found');
    }
  });

  router.delete('/:id', requireRole('OFFICER'), async (req, res) => {
    try {
      await prisma.repeater.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Repeater not found');
    }
  });

  return router;
}
```

- [ ] **Step 6.3: Mount router in `src/app.ts`**

Add `import { repeatersRouter } from './routes/repeaters.js';` near the other imports, and inside `buildApp` after the auth line add:

```ts
app.use('/api/repeaters', repeatersRouter(prisma));
```

- [ ] **Step 6.4: Run tests — expect PASS**

```bash
npm test -- test/routes/repeaters.test.ts
```

- [ ] **Step 6.5: Commit**

```bash
git add apps/api
git commit -m "feat(api): repeaters CRUD with role-gated writes"
```

---

## Task 7: API — nets CRUD (TDD)

**Files:**
- Create: `src/routes/nets.ts`, `test/routes/nets.test.ts`
- Modify: `src/app.ts`

- [ ] **Step 7.1: Write failing tests `test/routes/nets.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string; let repeaterId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer).send({
    name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM',
  });
  repeaterId = r.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => { await prisma.netSession.deleteMany(); await prisma.net.deleteMany(); });

const netBody = () => ({
  name: 'Wed Net', repeaterId, dayOfWeek: 3, startLocal: '20:00',
  timezone: 'America/Chicago', theme: 'Intro to CW', scriptMd: '# Hello',
});

describe('nets CRUD', () => {
  it('lists empty', async () => {
    const res = await request(app).get('/api/nets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
  it('creates, lists, updates, deletes', async () => {
    const c = await request(app).post('/api/nets').set('Cookie', officer).send(netBody());
    expect(c.status).toBe(201);
    expect(c.body.name).toBe('Wed Net');
    const list = await request(app).get('/api/nets');
    expect(list.body).toHaveLength(1);
    const u = await request(app).patch(`/api/nets/${c.body.id}`).set('Cookie', officer)
      .send({ ...netBody(), name: 'Wed Net v2' });
    expect(u.body.name).toBe('Wed Net v2');
    const d = await request(app).delete(`/api/nets/${c.body.id}`).set('Cookie', officer);
    expect(d.status).toBe(204);
  });
  it('validates startLocal format', async () => {
    const res = await request(app).post('/api/nets').set('Cookie', officer)
      .send({ ...netBody(), startLocal: '9pm' });
    expect(res.status).toBe(400);
  });
  it('rejects unauthenticated writes', async () => {
    const res = await request(app).post('/api/nets').send(netBody());
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 7.2: Create `src/routes/nets.ts`**

```ts
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { NetInput } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';

export function netsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const list = await prisma.net.findMany({
      orderBy: [{ dayOfWeek: 'asc' }, { startLocal: 'asc' }],
      include: { repeater: true },
    });
    res.json(list);
  });

  router.post('/', requireRole('OFFICER'), validateBody(NetInput), async (req, res) => {
    const body = req.body as typeof NetInput._type;
    const created = await prisma.net.create({
      data: {
        name: body.name, repeaterId: body.repeaterId,
        dayOfWeek: body.dayOfWeek, startLocal: body.startLocal,
        timezone: body.timezone, theme: body.theme ?? null, scriptMd: body.scriptMd ?? null,
        active: body.active ?? true,
      },
    });
    res.status(201).json(created);
  });

  router.patch('/:id', requireRole('OFFICER'), validateBody(NetInput), async (req, res) => {
    const body = req.body as typeof NetInput._type;
    try {
      const updated = await prisma.net.update({
        where: { id: req.params.id },
        data: {
          name: body.name, repeaterId: body.repeaterId,
          dayOfWeek: body.dayOfWeek, startLocal: body.startLocal,
          timezone: body.timezone, theme: body.theme ?? null, scriptMd: body.scriptMd ?? null,
          active: body.active ?? true,
        },
      });
      res.json(updated);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    }
  });

  router.delete('/:id', requireRole('OFFICER'), async (req, res) => {
    try {
      await prisma.net.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    }
  });

  return router;
}
```

- [ ] **Step 7.3: Mount in `src/app.ts`**

Add `import { netsRouter } from './routes/nets.js';` and `app.use('/api/nets', netsRouter(prisma));` after the repeaters mount.

- [ ] **Step 7.4: Run tests — expect PASS**

```bash
npm test -- test/routes/nets.test.ts
```

- [ ] **Step 7.5: Commit**

```bash
git add apps/api
git commit -m "feat(api): nets CRUD with Zod-validated schedule"
```

---

## Task 8: API — sessions + check-ins (TDD)

**Files:**
- Create: `src/routes/sessions.ts`, `src/routes/checkins.ts`, `test/routes/sessions.test.ts`, `test/routes/checkins.test.ts`
- Modify: `src/app.ts`

- [ ] **Step 8.1: Write failing `test/routes/sessions.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string; let netId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', officer).send({
    name: 'Wed Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  netId = n.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => {
  await prisma.checkIn.deleteMany();
  await prisma.netSession.deleteMany();
});

describe('sessions', () => {
  it('OFFICER starts a session', async () => {
    const res = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    expect(res.status).toBe(201);
    expect(res.body.netId).toBe(netId);
    expect(res.body.endedAt).toBeNull();
  });
  it('MEMBER cannot start', async () => {
    const m = await request(app).post('/api/auth/register').send({
      email: 'm@x.co', password: 'hunter2hunter2', name: 'M', callsign: 'KB0BOB',
    });
    const res = await request(app).post(`/api/nets/${netId}/sessions`)
      .set('Cookie', m.headers['set-cookie'][0]);
    expect(res.status).toBe(403);
  });
  it('PATCH ends session', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const u = await request(app).patch(`/api/sessions/${s.body.id}`).set('Cookie', officer)
      .send({ endedAt: new Date().toISOString(), notes: 'good net' });
    expect(u.status).toBe(200);
    expect(u.body.endedAt).not.toBeNull();
    expect(u.body.notes).toBe('good net');
  });
  it('GET session returns with checkins', async () => {
    const s = await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const g = await request(app).get(`/api/sessions/${s.body.id}`);
    expect(g.status).toBe(200);
    expect(g.body.checkIns).toEqual([]);
  });
  it('GET list filters by netId', async () => {
    await request(app).post(`/api/nets/${netId}/sessions`).set('Cookie', officer);
    const list = await request(app).get(`/api/sessions?netId=${netId}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 8.2: Create `src/routes/sessions.ts`**

```ts
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { NetSessionUpdate } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';

export function sessionsRouter(prisma: PrismaClient): { nested: Router; flat: Router } {
  const nested = Router({ mergeParams: true });
  const flat = Router();

  nested.post('/', requireRole('OFFICER'), async (req, res) => {
    const { netId } = req.params as { netId: string };
    const net = await prisma.net.findUnique({ where: { id: netId } });
    if (!net) throw new HttpError(404, 'NOT_FOUND', 'Net not found');
    const created = await prisma.netSession.create({
      data: { netId, startedAt: new Date(), controlOpId: req.user!.id },
    });
    res.status(201).json(created);
  });

  flat.get('/', async (req, res) => {
    const { netId, from, to } = req.query as Record<string, string | undefined>;
    const list = await prisma.netSession.findMany({
      where: {
        ...(netId ? { netId } : {}),
        ...(from || to
          ? { startedAt: { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined } }
          : {}),
      },
      orderBy: { startedAt: 'desc' },
    });
    res.json(list);
  });

  flat.get('/:id', async (req, res) => {
    const s = await prisma.netSession.findUnique({
      where: { id: req.params.id },
      include: { checkIns: { orderBy: { checkedInAt: 'desc' } } },
    });
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    res.json(s);
  });

  flat.patch('/:id', requireRole('OFFICER'), validateBody(NetSessionUpdate), async (req, res) => {
    const body = req.body as typeof NetSessionUpdate._type;
    try {
      const updated = await prisma.netSession.update({
        where: { id: req.params.id },
        data: {
          endedAt:
            body.endedAt === undefined ? undefined : body.endedAt ? new Date(body.endedAt) : null,
          notes: body.notes === undefined ? undefined : body.notes,
        },
      });
      res.json(updated);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    }
  });

  return { nested, flat };
}
```

- [ ] **Step 8.3: Mount in `src/app.ts`**

```ts
import { sessionsRouter } from './routes/sessions.js';
// inside buildApp, after nets mount:
const sessions = sessionsRouter(prisma);
app.use('/api/nets/:netId/sessions', sessions.nested);
app.use('/api/sessions', sessions.flat);
```

- [ ] **Step 8.4: Run sessions tests — expect PASS**

```bash
npm test -- test/routes/sessions.test.ts
```

- [ ] **Step 8.5: Write failing `test/routes/checkins.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string; let member: string; let sessionId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'A', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co', password: 'hunter2hunter2', name: 'Bob', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', officer).send({
    name: 'Wed Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  const s = await request(app).post(`/api/nets/${n.body.id}/sessions`).set('Cookie', officer);
  sessionId = s.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });
beforeEach(async () => { await prisma.checkIn.deleteMany(); });

describe('check-ins', () => {
  it('auth required', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .send({ callsign: 'W1AW', nameAtCheckIn: 'A' });
    expect(res.status).toBe(401);
  });

  it('member can check in (self)', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', member).send({ callsign: 'kb0bob', nameAtCheckIn: 'Bob' });
    expect(res.status).toBe(201);
    expect(res.body.callsign).toBe('KB0BOB');
    expect(res.body.userId).not.toBeNull();
  });

  it('officer can check in a visitor (no user match)', async () => {
    const res = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GUEST', nameAtCheckIn: 'Guest' });
    expect(res.status).toBe(201);
    expect(res.body.userId).toBeNull();
  });

  it('officer can delete any check-in', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', officer).send({ callsign: 'KC0GUEST', nameAtCheckIn: 'Guest' });
    const d = await request(app).delete(`/api/checkins/${c.body.id}`).set('Cookie', officer);
    expect(d.status).toBe(204);
  });

  it('member can delete own check-in within 5 min', async () => {
    const c = await request(app).post(`/api/sessions/${sessionId}/checkins`)
      .set('Cookie', member).send({ callsign: 'KB0BOB', nameAtCheckIn: 'Bob' });
    const d = await request(app).delete(`/api/checkins/${c.body.id}`).set('Cookie', member);
    expect(d.status).toBe(204);
  });
});
```

- [ ] **Step 8.6: Create `src/routes/checkins.ts`**

```ts
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { CheckInInput } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';

export function checkinsRouter(prisma: PrismaClient): { nested: Router; flat: Router } {
  const nested = Router({ mergeParams: true });
  const flat = Router();

  nested.post('/', requireAuth, validateBody(CheckInInput), async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = await prisma.netSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    if (session.endedAt) throw new HttpError(409, 'CONFLICT', 'Session already ended');
    const body = req.body as typeof CheckInInput._type;
    const matched = await prisma.user.findUnique({ where: { callsign: body.callsign } });
    const created = await prisma.checkIn.create({
      data: {
        sessionId, callsign: body.callsign, nameAtCheckIn: body.nameAtCheckIn,
        comment: body.comment ?? null, userId: matched?.id ?? null,
      },
    });
    res.status(201).json(created);
  });

  flat.delete('/:id', requireAuth, async (req, res) => {
    const ci = await prisma.checkIn.findUnique({ where: { id: req.params.id } });
    if (!ci) throw new HttpError(404, 'NOT_FOUND', 'Check-in not found');
    const me = req.user!;
    const isOfficer = me.role === 'OFFICER' || me.role === 'ADMIN';
    const ownRecent =
      ci.userId === me.id && Date.now() - ci.checkedInAt.getTime() < 5 * 60 * 1000;
    if (!isOfficer && !ownRecent) {
      throw new HttpError(403, 'FORBIDDEN', 'Cannot delete this check-in');
    }
    await prisma.checkIn.delete({ where: { id: ci.id } });
    res.status(204).end();
  });

  return { nested, flat };
}
```

- [ ] **Step 8.7: Mount in `src/app.ts`**

```ts
import { checkinsRouter } from './routes/checkins.js';
// inside buildApp:
const checkins = checkinsRouter(prisma);
app.use('/api/sessions/:sessionId/checkins', checkins.nested);
app.use('/api/checkins', checkins.flat);
```

- [ ] **Step 8.8: Run tests — expect PASS**

```bash
npm test -- test/routes/checkins.test.ts
```

- [ ] **Step 8.9: Commit**

```bash
git add apps/api
git commit -m "feat(api): net sessions and check-ins with member/officer rules"
```

---

## Task 9: API — stats endpoints + CSV/PDF export (TDD)

**Files:**
- Create: `src/lib/csv.ts`, `src/lib/pdf.tsx`, `src/routes/stats.ts`, `test/routes/stats.test.ts`
- Modify: `src/app.ts`

- [ ] **Step 9.1: Write failing `test/routes/stats.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let officer: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'Alice', callsign: 'W1AW',
  });
  officer = a.headers['set-cookie'][0];
  const r = await request(app).post('/api/repeaters').set('Cookie', officer)
    .send({ name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' });
  const n = await request(app).post('/api/nets').set('Cookie', officer).send({
    name: 'Wed Net', repeaterId: r.body.id, dayOfWeek: 3,
    startLocal: '20:00', timezone: 'America/Chicago',
  });
  const s = await request(app).post(`/api/nets/${n.body.id}/sessions`).set('Cookie', officer);
  await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', officer)
    .send({ callsign: 'W1AW', nameAtCheckIn: 'Alice' });
  await request(app).post(`/api/sessions/${s.body.id}/checkins`).set('Cookie', officer)
    .send({ callsign: 'KC0GUEST', nameAtCheckIn: 'Guest' });
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('stats', () => {
  it('GET /api/stats/participation returns totals', async () => {
    const res = await request(app).get('/api/stats/participation');
    expect(res.status).toBe(200);
    expect(res.body.totalCheckIns).toBe(2);
    expect(res.body.totalSessions).toBe(1);
    expect(res.body.perNet).toHaveLength(1);
  });

  it('GET /api/stats/export.csv streams CSV', async () => {
    const res = await request(app).get('/api/stats/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toMatch(/callsign/i);
    expect(res.text).toMatch(/W1AW/);
    expect(res.text).toMatch(/KC0GUEST/);
  });

  it('GET /api/stats/export.pdf returns PDF bytes', async () => {
    const res = await request(app).get('/api/stats/export.pdf').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect((res.body as Buffer).slice(0, 5).toString()).toBe('%PDF-');
  });
});
```

- [ ] **Step 9.2: Create `src/lib/csv.ts`**

```ts
export function toCsvRow(values: Array<string | number | null | undefined>): string {
  return (
    values
      .map((v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(',') + '\n'
  );
}
```

- [ ] **Step 9.3: Create `src/lib/pdf.tsx`**

```tsx
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToStream } from '@react-pdf/renderer';
import type { ParticipationStats } from '@hna/shared';

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: 'Helvetica' },
  h1: { fontSize: 20, marginBottom: 12, color: '#512888' },
  h2: { fontSize: 14, marginTop: 16, marginBottom: 6 },
  row: { flexDirection: 'row', borderBottom: '1 solid #ddd', paddingVertical: 3 },
  cellWide: { flex: 3 },
  cellNarrow: { flex: 1, textAlign: 'right' },
});

export function ParticipationPdf({
  stats,
  clubName,
}: {
  stats: ParticipationStats;
  clubName: string;
}) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>{clubName} — Participation Report</Text>
        <Text>
          Range: {stats.range.from.slice(0, 10)} to {stats.range.to.slice(0, 10)}
        </Text>
        <Text>
          Total sessions: {stats.totalSessions} · Total check-ins: {stats.totalCheckIns}
        </Text>

        <Text style={styles.h2}>Per member</Text>
        {stats.perMember.map((m) => (
          <View style={styles.row} key={m.callsign}>
            <Text style={styles.cellWide}>
              {m.callsign} — {m.name}
            </Text>
            <Text style={styles.cellNarrow}>{m.count}</Text>
          </View>
        ))}

        <Text style={styles.h2}>Per net</Text>
        {stats.perNet.map((n) => (
          <View style={styles.row} key={n.netId}>
            <Text style={styles.cellWide}>{n.netName}</Text>
            <Text style={styles.cellNarrow}>
              {n.sessions} sess · {n.checkIns} ins
            </Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function renderParticipationPdf(
  stats: ParticipationStats,
  clubName: string,
): Promise<NodeJS.ReadableStream> {
  return renderToStream(<ParticipationPdf stats={stats} clubName={clubName} />);
}
```

- [ ] **Step 9.4: Create `src/routes/stats.ts`**

```ts
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import type { ParticipationStats } from '@hna/shared';
import { toCsvRow } from '../lib/csv.js';
import { renderParticipationPdf } from '../lib/pdf.js';

function parseRange(q: Record<string, string | undefined>): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 180 * 24 * 60 * 60 * 1000);
  return { from, to };
}

async function computeStats(
  prisma: PrismaClient,
  from: Date,
  to: Date,
): Promise<ParticipationStats> {
  const sessions = await prisma.netSession.findMany({
    where: { startedAt: { gte: from, lte: to } },
    include: { net: true, checkIns: true },
  });
  const perMemberMap = new Map<string, { callsign: string; name: string; count: number }>();
  const perNetMap = new Map<
    string,
    { netId: string; netName: string; sessions: number; checkIns: number }
  >();
  let totalCheckIns = 0;
  for (const s of sessions) {
    const netAgg = perNetMap.get(s.netId) ?? {
      netId: s.netId,
      netName: s.net.name,
      sessions: 0,
      checkIns: 0,
    };
    netAgg.sessions += 1;
    for (const ci of s.checkIns) {
      totalCheckIns += 1;
      netAgg.checkIns += 1;
      const m = perMemberMap.get(ci.callsign) ?? {
        callsign: ci.callsign,
        name: ci.nameAtCheckIn,
        count: 0,
      };
      m.count += 1;
      perMemberMap.set(ci.callsign, m);
    }
    perNetMap.set(s.netId, netAgg);
  }
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totalSessions: sessions.length,
    totalCheckIns,
    perMember: [...perMemberMap.values()].sort((a, b) => b.count - a.count),
    perNet: [...perNetMap.values()],
  };
}

export function statsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/participation', async (req, res) => {
    const { from, to } = parseRange(req.query as Record<string, string | undefined>);
    res.json(await computeStats(prisma, from, to));
  });

  router.get('/export.csv', async (req, res) => {
    const { from, to } = parseRange(req.query as Record<string, string | undefined>);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="checkins.csv"');
    res.write(toCsvRow(['checkedInAt', 'netName', 'callsign', 'name', 'comment']));
    const checkIns = await prisma.checkIn.findMany({
      where: { session: { startedAt: { gte: from, lte: to } } },
      include: { session: { include: { net: true } } },
      orderBy: { checkedInAt: 'asc' },
    });
    for (const ci of checkIns) {
      res.write(
        toCsvRow([
          ci.checkedInAt.toISOString(),
          ci.session.net.name,
          ci.callsign,
          ci.nameAtCheckIn,
          ci.comment,
        ]),
      );
    }
    res.end();
  });

  router.get('/export.pdf', async (req, res) => {
    const { from, to } = parseRange(req.query as Record<string, string | undefined>);
    const stats = await computeStats(prisma, from, to);
    const stream = await renderParticipationPdf(stats, 'Ham-Net-Assistant Club');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="participation.pdf"');
    stream.pipe(res);
  });

  return router;
}
```

- [ ] **Step 9.5: Mount in `src/app.ts`**

```ts
import { statsRouter } from './routes/stats.js';
app.use('/api/stats', statsRouter(prisma));
```

- [ ] **Step 9.6: Run stats tests — expect PASS**

```bash
npm test -- test/routes/stats.test.ts
```

- [ ] **Step 9.7: Commit**

```bash
git add apps/api
git commit -m "feat(api): participation stats + CSV/PDF exports"
```

---

## Task 10: API — themes and users routes (TDD)

**Files:**
- Create: `src/routes/themes.ts`, `src/routes/users.ts`, `test/routes/themes.test.ts`, `test/routes/users.test.ts`
- Modify: `src/app.ts`

- [ ] **Step 10.1: Write failing `test/routes/themes.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
beforeAll(async () => { ({ app, prisma, dbFile } = await makeTestApp()); });
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('GET /api/themes', () => {
  it('returns default theme at minimum, no auth required', async () => {
    const res = await request(app).get('/api/themes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const slugs = (res.body as Array<{ slug: string }>).map((t) => t.slug);
    expect(slugs).toContain('default');
  });
});
```

- [ ] **Step 10.2: Create `src/routes/themes.ts`**

```ts
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

interface ThemeJson {
  slug: string;
  name: string;
  shortName: string;
  colors: Record<string, string>;
  font: { display: string; body: string };
  logo: { file: string; alt: string; maxHeightPx: number };
  attribution?: string;
}

function loadThemes(): ThemeJson[] {
  const candidates = [
    path.resolve(process.cwd(), '../../themes'),
    path.resolve(process.cwd(), 'themes'),
  ];
  const dir = candidates.find((p) => fs.existsSync(p));
  if (!dir) return [];
  const out: ThemeJson[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name, 'theme.json');
    if (!fs.existsSync(full)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(full, 'utf8')) as ThemeJson);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function themesRouter(): Router {
  const router = Router();
  const themes = loadThemes();
  router.get('/', (_req, res) => res.json(themes));
  return router;
}
```

- [ ] **Step 10.3: Write failing `test/routes/users.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { makeTestApp, cleanupTestDb } from '../helpers.js';

let app: Express; let prisma: PrismaClient; let dbFile: string;
let admin: string; let member: string; let memberId: string;

beforeAll(async () => {
  ({ app, prisma, dbFile } = await makeTestApp());
  const a = await request(app).post('/api/auth/register').send({
    email: 'a@x.co', password: 'hunter2hunter2', name: 'Admin', callsign: 'W1AW',
  });
  admin = a.headers['set-cookie'][0];
  const m = await request(app).post('/api/auth/register').send({
    email: 'm@x.co', password: 'hunter2hunter2', name: 'Bob', callsign: 'KB0BOB',
  });
  member = m.headers['set-cookie'][0];
  memberId = m.body.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('users', () => {
  it('PATCH /api/users/me updates self', async () => {
    const res = await request(app).patch('/api/users/me').set('Cookie', member)
      .send({ collegeSlug: 'kstate', name: 'Robert' });
    expect(res.status).toBe(200);
    expect(res.body.collegeSlug).toBe('kstate');
    expect(res.body.name).toBe('Robert');
  });
  it('GET /api/users [ADMIN only]', async () => {
    const forbidden = await request(app).get('/api/users').set('Cookie', member);
    expect(forbidden.status).toBe(403);
    const ok = await request(app).get('/api/users').set('Cookie', admin);
    expect(ok.status).toBe(200);
    expect(ok.body.length).toBe(2);
  });
  it('PATCH /api/users/:id/role [ADMIN]', async () => {
    const res = await request(app).patch(`/api/users/${memberId}/role`).set('Cookie', admin)
      .send({ role: 'OFFICER' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('OFFICER');
  });
});
```

- [ ] **Step 10.4: Create `src/routes/users.ts`**

```ts
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { UpdateMeInput, UpdateRoleInput, PublicUser } from '@hna/shared';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';

const publicSelect = {
  id: true,
  email: true,
  name: true,
  callsign: true,
  role: true,
  collegeSlug: true,
} as const;

export function usersRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.patch('/me', requireAuth, validateBody(UpdateMeInput), async (req, res) => {
    const body = req.body as typeof UpdateMeInput._type;
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        name: body.name ?? undefined,
        collegeSlug: body.collegeSlug === undefined ? undefined : body.collegeSlug,
      },
      select: publicSelect,
    });
    res.json(PublicUser.parse(updated));
  });

  router.get('/', requireRole('ADMIN'), async (_req, res) => {
    const users = await prisma.user.findMany({
      select: publicSelect,
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map((u) => PublicUser.parse(u)));
  });

  router.patch('/:id/role', requireRole('ADMIN'), validateBody(UpdateRoleInput), async (req, res) => {
    try {
      const updated = await prisma.user.update({
        where: { id: req.params.id },
        data: { role: (req.body as typeof UpdateRoleInput._type).role },
        select: publicSelect,
      });
      res.json(PublicUser.parse(updated));
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'User not found');
    }
  });

  return router;
}
```

- [ ] **Step 10.5: Mount both in `src/app.ts`**

```ts
import { themesRouter } from './routes/themes.js';
import { usersRouter } from './routes/users.js';
// inside buildApp:
app.use('/api/themes', themesRouter());
app.use('/api/users', usersRouter(prisma));
```

- [ ] **Step 10.6: Run users + themes tests — expect PASS**

```bash
npm test -- test/routes/users.test.ts test/routes/themes.test.ts
```

- [ ] **Step 10.7: Commit**

```bash
git add apps/api
git commit -m "feat(api): themes and users admin routes"
```

---

## Task 11: Themes folder with 6 colleges

**Files:**
- Create: `themes/README.md`, `themes/{default,kstate,mit,georgiatech,virginiatech,illinois}/theme.json`, `themes/*/logo.svg`

- [ ] **Step 11.1: Create `themes/README.md`**

```markdown
# Themes

Each subdirectory is one college theme:

    themes/<slug>/theme.json   # colors, fonts, logo metadata
    themes/<slug>/logo.svg     # optional; see trademark note

## Trademark note

**Do not commit college logos to this public repo.** University seals and
marks (K-State Powercat, MIT seal, Georgia Tech Buzz, Virginia Tech VT,
Illinois Block I, etc.) are trademarks. Each club should obtain written
permission from their university licensing office and drop the approved
asset into `themes/<slug>/logo.svg` on their local/deployed copy.

If the file is missing or empty, Ham-Net-Assistant renders a neutral
ham-radio icon with the theme's `shortName`.

## Adding a new college

1. `cp -r themes/default themes/<slug>`
2. Edit `theme.json`: slug, name, shortName, colors, font, attribution
3. Restart the app — themes are auto-discovered
```

- [ ] **Step 11.2: Create `themes/default/theme.json`**

```json
{
  "slug": "default",
  "name": "Ham-Net-Assistant Default",
  "shortName": "HNA",
  "colors": {
    "primary": "#2B5B8C",
    "primaryFg": "#FFFFFF",
    "accent": "#F2A900",
    "bg": "#FFFFFF",
    "bgMuted": "#F4F6F9",
    "fg": "#101828",
    "border": "#D0D5DD",
    "success": "#2E7D32",
    "danger": "#C62828"
  },
  "font": {
    "display": "'Inter', system-ui, sans-serif",
    "body": "'Inter', system-ui, sans-serif"
  },
  "logo": { "file": "logo.svg", "alt": "Ham-Net-Assistant", "maxHeightPx": 56 },
  "attribution": "Original artwork, free to use."
}
```

- [ ] **Step 11.3: Create `themes/default/logo.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="HNA">
  <circle cx="32" cy="32" r="30" fill="#2B5B8C"/>
  <path d="M14 40 Q32 10 50 40" stroke="#F2A900" stroke-width="3" fill="none"/>
  <circle cx="32" cy="40" r="5" fill="#F2A900"/>
  <text x="32" y="57" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#fff">HNA</text>
</svg>
```

- [ ] **Step 11.4: Create `themes/kstate/theme.json`**

```json
{
  "slug": "kstate",
  "name": "Kansas State University",
  "shortName": "K-State",
  "colors": {
    "primary": "#512888",
    "primaryFg": "#FFFFFF",
    "accent": "#A7A9AC",
    "bg": "#FFFFFF",
    "bgMuted": "#F4F1F8",
    "fg": "#1C1C1C",
    "border": "#D4C9E2",
    "success": "#2E7D32",
    "danger": "#C62828"
  },
  "font": {
    "display": "'Inter', system-ui, sans-serif",
    "body": "'Inter', system-ui, sans-serif"
  },
  "logo": { "file": "logo.svg", "alt": "K-State Powercat", "maxHeightPx": 64 },
  "attribution": "Colors per K-State brand guide. Logo not included — provide your own with permission."
}
```

- [ ] **Step 11.5: Create `themes/mit/theme.json`**

```json
{
  "slug": "mit",
  "name": "Massachusetts Institute of Technology",
  "shortName": "MIT",
  "colors": {
    "primary": "#A31F34",
    "primaryFg": "#FFFFFF",
    "accent": "#8A8B8C",
    "bg": "#FFFFFF",
    "bgMuted": "#F7F2F3",
    "fg": "#1C1C1C",
    "border": "#E4D4D6",
    "success": "#2E7D32",
    "danger": "#7E1220"
  },
  "font": {
    "display": "'Inter', system-ui, sans-serif",
    "body": "'Inter', system-ui, sans-serif"
  },
  "logo": { "file": "logo.svg", "alt": "MIT", "maxHeightPx": 56 },
  "attribution": "Colors per MIT identity standards. Logo not included — provide your own with permission."
}
```

- [ ] **Step 11.6: Create `themes/georgiatech/theme.json`**

```json
{
  "slug": "georgiatech",
  "name": "Georgia Institute of Technology",
  "shortName": "Georgia Tech",
  "colors": {
    "primary": "#003057",
    "primaryFg": "#FFFFFF",
    "accent": "#B3A369",
    "bg": "#FFFFFF",
    "bgMuted": "#F3F4F7",
    "fg": "#1C1C1C",
    "border": "#CBD5E1",
    "success": "#2E7D32",
    "danger": "#C62828"
  },
  "font": {
    "display": "'Inter', system-ui, sans-serif",
    "body": "'Inter', system-ui, sans-serif"
  },
  "logo": { "file": "logo.svg", "alt": "Georgia Tech", "maxHeightPx": 56 },
  "attribution": "Colors per Georgia Tech brand. Logo not included — provide your own with permission."
}
```

- [ ] **Step 11.7: Create `themes/virginiatech/theme.json`**

```json
{
  "slug": "virginiatech",
  "name": "Virginia Polytechnic Institute and State University",
  "shortName": "Virginia Tech",
  "colors": {
    "primary": "#630031",
    "primaryFg": "#FFFFFF",
    "accent": "#CF4420",
    "bg": "#FFFFFF",
    "bgMuted": "#F8F1F3",
    "fg": "#1C1C1C",
    "border": "#E2CAD2",
    "success": "#2E7D32",
    "danger": "#7E1220"
  },
  "font": {
    "display": "'Inter', system-ui, sans-serif",
    "body": "'Inter', system-ui, sans-serif"
  },
  "logo": { "file": "logo.svg", "alt": "Virginia Tech", "maxHeightPx": 56 },
  "attribution": "Colors per Virginia Tech brand. Logo not included — provide your own with permission."
}
```

- [ ] **Step 11.8: Create `themes/illinois/theme.json`**

```json
{
  "slug": "illinois",
  "name": "University of Illinois Urbana-Champaign",
  "shortName": "Illinois",
  "colors": {
    "primary": "#13294B",
    "primaryFg": "#FFFFFF",
    "accent": "#E84A27",
    "bg": "#FFFFFF",
    "bgMuted": "#F2F3F7",
    "fg": "#1C1C1C",
    "border": "#CED4DF",
    "success": "#2E7D32",
    "danger": "#C62828"
  },
  "font": {
    "display": "'Inter', system-ui, sans-serif",
    "body": "'Inter', system-ui, sans-serif"
  },
  "logo": { "file": "logo.svg", "alt": "Illinois", "maxHeightPx": 56 },
  "attribution": "Colors per Illinois brand. Logo not included — provide your own with permission."
}
```

- [ ] **Step 11.9: Create empty placeholder logos for the 5 college themes**

Each file is the same 1-line empty SVG:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>
```

Create this file at:
- `themes/kstate/logo.svg`
- `themes/mit/logo.svg`
- `themes/georgiatech/logo.svg`
- `themes/virginiatech/logo.svg`
- `themes/illinois/logo.svg`

- [ ] **Step 11.10: Commit**

```bash
git add themes
git commit -m "feat(themes): default + 5 college themes (colors only, empty logo slots)"
```

---

## Task 12: Web — package scaffold + theme registry

**Files:**
- Create: `apps/web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/styles/reset.css`, `src/styles/theme-vars.css`, `src/theme/registry.ts`, `src/test-setup.ts`

- [ ] **Step 12.1: Create `apps/web/package.json`**

```json
{
  "name": "@hna/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@hna/shared": "*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.23.0",
    "zustand": "^4.5.2",
    "recharts": "^2.12.6"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.2",
    "@testing-library/react": "^15.0.2",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.2.1",
    "jsdom": "^24.0.0",
    "typescript": "^5.4.5",
    "vite": "^5.2.10",
    "vitest": "^1.5.0"
  }
}
```

- [ ] **Step 12.2: Create `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"],
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src/**/*", "vite.config.ts"]
}
```

- [ ] **Step 12.3: Create `apps/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
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
  },
});
```

- [ ] **Step 12.4: Create `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ham-Net-Assistant</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 12.5: Create `src/test-setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 12.6: Create `src/styles/reset.css`**

```css
*, *::before, *::after { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  font-family: var(--font-body, system-ui, sans-serif);
  color: var(--color-fg, #101828);
  background: var(--color-bg, #ffffff);
}
button { font: inherit; }
```

- [ ] **Step 12.7: Create `src/styles/theme-vars.css`**

```css
:root {
  --color-primary: #2B5B8C;
  --color-primary-fg: #FFFFFF;
  --color-accent: #F2A900;
  --color-bg: #FFFFFF;
  --color-bg-muted: #F4F6F9;
  --color-fg: #101828;
  --color-border: #D0D5DD;
  --color-success: #2E7D32;
  --color-danger: #C62828;
  --font-display: 'Inter', system-ui, sans-serif;
  --font-body: 'Inter', system-ui, sans-serif;
}
```

- [ ] **Step 12.8: Create `src/theme/registry.ts`**

```ts
export interface Theme {
  slug: string;
  name: string;
  shortName: string;
  colors: Record<string, string>;
  font: { display: string; body: string };
  logo: { file: string; alt: string; maxHeightPx: number };
  logoUrl: string;
  attribution?: string;
}

const themeJsons = import.meta.glob('@themes/*/theme.json', { eager: true }) as Record<
  string,
  { default: Omit<Theme, 'logoUrl'> }
>;
const logos = import.meta.glob('@themes/*/logo.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export const themes: Theme[] = Object.entries(themeJsons)
  .map(([jsonPath, mod]) => {
    const dir = jsonPath.replace(/\/theme\.json$/, '');
    const logoUrl = logos[`${dir}/logo.svg`] ?? '';
    return { ...(mod.default as Omit<Theme, 'logoUrl'>), logoUrl };
  })
  .sort((a, b) =>
    a.slug === 'default' ? -1 : b.slug === 'default' ? 1 : a.name.localeCompare(b.name),
  );

export function themeBySlug(slug: string | null | undefined): Theme {
  return (
    themes.find((t) => t.slug === slug) ??
    themes.find((t) => t.slug === 'default') ??
    themes[0]
  );
}
```

- [ ] **Step 12.9: Create placeholder `src/main.tsx`**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/reset.css';
import './styles/theme-vars.css';

createRoot(document.getElementById('root')!).render(<div>Ham-Net-Assistant — booting</div>);
```

- [ ] **Step 12.10: Install and verify build**

```bash
cd apps/web && npm install && npm run build && npm run typecheck
```
Expected: `dist/` produced, no errors.

- [ ] **Step 12.11: Commit**

```bash
cd ../..
git add apps/web package-lock.json
git commit -m "feat(web): vite+react scaffold, theme registry via import.meta.glob"
```

---

## Task 13: Web — API client + auth store + ThemeProvider

**Files:**
- Create: `src/api/client.ts`, `src/auth/AuthProvider.tsx`, `src/theme/ThemeProvider.tsx`

- [ ] **Step 13.1: Create `src/api/client.ts`**

```ts
import type { ApiError } from '@hna/shared';

export class ApiErrorException extends Error {
  constructor(public status: number, public payload: ApiError['error']) {
    super(payload.message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    if (!res.ok) {
      throw new ApiErrorException(res.status, { code: 'INTERNAL', message: res.statusText });
    }
    return (await res.blob()) as T;
  }
  const body = await res.json();
  if (!res.ok) {
    throw new ApiErrorException(res.status, body.error);
  }
  return body as T;
}
```

- [ ] **Step 13.2: Create `src/auth/AuthProvider.tsx`**

```tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import type { PublicUser, RegisterInput, LoginInput } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';

interface AuthCtx {
  user: PublicUser | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  updateMe: (patch: Partial<Pick<PublicUser, 'name' | 'collegeSlug'>>) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<PublicUser>('/auth/me')
      .then(setUser)
      .catch((e) => {
        if (e instanceof ApiErrorException && e.status === 401) setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login: AuthCtx['login'] = async (input) => {
    setUser(
      await apiFetch<PublicUser>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
    );
  };
  const register: AuthCtx['register'] = async (input) => {
    setUser(
      await apiFetch<PublicUser>('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
    );
  };
  const logout: AuthCtx['logout'] = async () => {
    await apiFetch<void>('/auth/logout', { method: 'POST' });
    setUser(null);
  };
  const updateMe: AuthCtx['updateMe'] = async (patch) => {
    setUser(
      await apiFetch<PublicUser>('/users/me', { method: 'PATCH', body: JSON.stringify(patch) }),
    );
  };

  return (
    <Ctx.Provider value={{ user, loading, login, register, logout, updateMe }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
```

- [ ] **Step 13.3: Create `src/theme/ThemeProvider.tsx`**

```tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import { themes, themeBySlug, type Theme } from './registry.js';
import { useAuth } from '../auth/AuthProvider.js';

interface ThemeCtx {
  current: Theme;
  all: Theme[];
  setTheme: (slug: string) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const LS_KEY = 'hna_theme_slug';

function applyTheme(t: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = t.slug;
  const c = t.colors;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set('--color-primary', c.primary);
  set('--color-primary-fg', c.primaryFg);
  set('--color-accent', c.accent);
  set('--color-bg', c.bg);
  set('--color-bg-muted', c.bgMuted);
  set('--color-fg', c.fg);
  set('--color-border', c.border);
  set('--color-success', c.success);
  set('--color-danger', c.danger);
  set('--font-display', t.font.display);
  set('--font-body', t.font.body);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { user, updateMe } = useAuth();
  const [slug, setSlug] = useState<string>(
    () => user?.collegeSlug ?? localStorage.getItem(LS_KEY) ?? 'default',
  );

  useEffect(() => {
    if (user?.collegeSlug && user.collegeSlug !== slug) setSlug(user.collegeSlug);
  }, [user?.collegeSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    applyTheme(themeBySlug(slug));
    localStorage.setItem(LS_KEY, slug);
  }, [slug]);

  const setTheme = (next: string) => {
    setSlug(next);
    if (user) void updateMe({ collegeSlug: next });
  };

  return (
    <Ctx.Provider value={{ current: themeBySlug(slug), all: themes, setTheme }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
```

- [ ] **Step 13.4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): api client, auth provider, theme provider"
```

---

## Task 14: Web — UI primitives + CallsignInput (with tests)

**Files:**
- Create: `src/components/ui/{Button.tsx,Input.tsx,Modal.tsx,Card.tsx,ui.css}`, `src/components/CallsignInput.tsx`, `src/components/CallsignInput.test.tsx`

- [ ] **Step 14.1: Create `src/components/ui/ui.css`**

```css
.hna-btn {
  background: var(--color-primary); color: var(--color-primary-fg);
  border: 1px solid var(--color-primary); border-radius: 6px;
  padding: 8px 14px; cursor: pointer;
}
.hna-btn.secondary {
  background: var(--color-bg); color: var(--color-fg);
  border-color: var(--color-border);
}
.hna-btn.danger { background: var(--color-danger); border-color: var(--color-danger); color: #fff; }
.hna-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.hna-input {
  width: 100%; padding: 8px 10px; font: inherit;
  color: var(--color-fg); background: var(--color-bg);
  border: 1px solid var(--color-border); border-radius: 6px;
}
.hna-input:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }

.hna-card {
  background: var(--color-bg); color: var(--color-fg);
  border: 1px solid var(--color-border); border-radius: 8px;
  padding: 16px;
}

.hna-modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.hna-modal {
  background: var(--color-bg); color: var(--color-fg);
  border-radius: 10px; padding: 24px; max-width: 560px; width: 92%;
  border: 1px solid var(--color-border);
}
```

- [ ] **Step 14.2: Create `src/components/ui/Button.tsx`**

```tsx
import React from 'react';
import './ui.css';

type Variant = 'primary' | 'secondary' | 'danger';

export function Button({
  variant = 'primary',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`hna-btn ${variant === 'primary' ? '' : variant} ${className}`}
      {...rest}
    />
  );
}
```

- [ ] **Step 14.3: Create `src/components/ui/Input.tsx`**

```tsx
import React from 'react';
import './ui.css';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`hna-input ${className}`} {...rest} />;
  },
);
```

- [ ] **Step 14.4: Create `src/components/ui/Card.tsx`**

```tsx
import React from 'react';
import './ui.css';

export function Card({
  children,
  className = '',
}: React.PropsWithChildren<{ className?: string }>) {
  return <div className={`hna-card ${className}`}>{children}</div>;
}
```

- [ ] **Step 14.5: Create `src/components/ui/Modal.tsx`**

```tsx
import React, { useEffect } from 'react';
import './ui.css';

export function Modal({
  open,
  onClose,
  children,
}: React.PropsWithChildren<{ open: boolean; onClose: () => void }>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="hna-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="hna-modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 14.6: Create failing `src/components/CallsignInput.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CallsignInput } from './CallsignInput.js';

describe('CallsignInput', () => {
  it('uppercases as the user types', async () => {
    const onChange = vi.fn();
    render(<CallsignInput value="" onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox'), 'w1aw');
    expect(onChange).toHaveBeenLastCalledWith('W1AW');
  });

  it('marks invalid value as aria-invalid', () => {
    render(<CallsignInput value="X" onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('marks valid value as not invalid', () => {
    render(<CallsignInput value="W1AW" onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false');
  });
});
```

- [ ] **Step 14.7: Create `src/components/CallsignInput.tsx`**

```tsx
import React from 'react';
import { Input } from './ui/Input.js';

const CALLSIGN_RE = /^[A-Z0-9]{3,7}$/;

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string;
  onChange: (next: string) => void;
}

export const CallsignInput = React.forwardRef<HTMLInputElement, Props>(
  function CallsignInput({ value, onChange, ...rest }, ref) {
    const valid = CALLSIGN_RE.test(value);
    return (
      <Input
        ref={ref}
        {...rest}
        value={value}
        aria-invalid={value.length === 0 ? undefined : !valid}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        placeholder="W1AW"
      />
    );
  },
);
```

- [ ] **Step 14.8: Run tests — expect PASS**

```bash
cd apps/web && npm test
```

- [ ] **Step 14.9: Commit**

```bash
cd ../..
git add apps/web/src
git commit -m "feat(web): UI primitives and CallsignInput with tests"
```

---

## Task 15: Web — App shell, Router, auth + settings pages, theme picker

**Files:**
- Create: `src/App.tsx`, `src/auth/LoginPage.tsx`, `src/auth/RegisterPage.tsx`, `src/auth/RequireRole.tsx`, `src/pages/SettingsPage.tsx`, `src/theme/ThemePicker.tsx`, stub page files
- Modify: `src/main.tsx`

- [ ] **Step 15.1: Create `src/auth/RequireRole.tsx`**

```tsx
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '@hna/shared';
import { useAuth } from './AuthProvider.js';

const ORDER: Record<Role, number> = { MEMBER: 0, OFFICER: 1, ADMIN: 2 };

export function RequireRole({
  min = 'MEMBER',
  children,
}: React.PropsWithChildren<{ min?: Role }>) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div>Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc }} />;
  if (ORDER[user.role] < ORDER[min]) return <div>Forbidden</div>;
  return <>{children}</>;
}
```

- [ ] **Step 15.2: Create `src/auth/LoginPage.tsx`**

```tsx
import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { useAuth } from './AuthProvider.js';
import { ApiErrorException } from '../api/client.js';

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await login({ email, password });
      nav('/');
    } catch (ex) {
      if (ex instanceof ApiErrorException) setErr(ex.payload.message);
      else setErr('Login failed');
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '60px auto' }}>
      <Card>
        <h1>Sign in</h1>
        <form onSubmit={submit}>
          <label>
            Email
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Password
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {err && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 12 }}>
              {err}
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
            <Button type="submit">Sign in</Button>
            <Link to="/register">Register</Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
```

- [ ] **Step 15.3: Create `src/auth/RegisterPage.tsx`**

```tsx
import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { useAuth } from './AuthProvider.js';
import { ApiErrorException } from '../api/client.js';

export function RegisterPage() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({
    email: '',
    password: '',
    name: '',
    callsign: '',
    inviteCode: '',
  });
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await register({
        email: form.email,
        password: form.password,
        name: form.name,
        callsign: form.callsign,
        inviteCode: form.inviteCode || undefined,
      });
      nav('/');
    } catch (ex) {
      if (ex instanceof ApiErrorException) setErr(ex.payload.message);
      else setErr('Registration failed');
    }
  }

  const update = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div style={{ maxWidth: 420, margin: '60px auto' }}>
      <Card>
        <h1>Create account</h1>
        <form onSubmit={submit}>
          <label>
            Name
            <Input
              value={form.name}
              onChange={(e) => update('name')(e.target.value)}
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Email
            <Input
              type="email"
              value={form.email}
              onChange={(e) => update('email')(e.target.value)}
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Callsign
            <CallsignInput value={form.callsign} onChange={update('callsign')} />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Password
            <Input
              type="password"
              value={form.password}
              minLength={8}
              onChange={(e) => update('password')(e.target.value)}
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Invite code (if required)
            <Input
              value={form.inviteCode}
              onChange={(e) => update('inviteCode')(e.target.value)}
            />
          </label>
          {err && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 12 }}>
              {err}
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
            <Button type="submit">Create account</Button>
            <Link to="/login">Sign in</Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
```

- [ ] **Step 15.4: Create `src/theme/ThemePicker.tsx`**

```tsx
import React from 'react';
import { useTheme } from './ThemeProvider.js';
import { Card } from '../components/ui/Card.js';

export function ThemePicker() {
  const { current, all, setTheme } = useTheme();
  return (
    <Card>
      <h3>College theme</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 12,
        }}
      >
        {all.map((t) => (
          <button
            key={t.slug}
            type="button"
            onClick={() => setTheme(t.slug)}
            aria-pressed={current.slug === t.slug}
            style={{
              cursor: 'pointer',
              padding: 12,
              border: `2px solid ${current.slug === t.slug ? t.colors.primary : 'var(--color-border)'}`,
              borderRadius: 8,
              background: t.colors.bg,
              color: t.colors.fg,
              textAlign: 'left',
            }}
          >
            <div
              style={{
                width: '100%',
                height: 32,
                background: t.colors.primary,
                borderRadius: 4,
                marginBottom: 8,
              }}
            />
            <strong style={{ display: 'block' }}>{t.shortName}</strong>
            <small>{t.name}</small>
          </button>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 15.5: Create `src/pages/SettingsPage.tsx`**

```tsx
import React, { useState } from 'react';
import { Card } from '../components/ui/Card.js';
import { Input } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { useAuth } from '../auth/AuthProvider.js';
import { ThemePicker } from '../theme/ThemePicker.js';

export function SettingsPage() {
  const { user, updateMe } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  if (!user) return null;
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 800, margin: '24px auto' }}>
      <Card>
        <h2>Profile</h2>
        <label>
          Name
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div style={{ marginTop: 12 }}>
          <Button onClick={() => updateMe({ name })}>Save</Button>
        </div>
        <p>
          Callsign: <strong>{user.callsign}</strong> (contact admin to change)
        </p>
        <p>Role: {user.role}</p>
      </Card>
      <ThemePicker />
    </div>
  );
}
```

- [ ] **Step 15.6: Create stub page files**

Create these 6 files, each with this exact content (substitute the function name per file to match):

```tsx
import React from 'react';
export function Dashboard() { return <div style={{ padding: 24 }}>Dashboard (Task 16)</div>; }
```

- `src/pages/Dashboard.tsx` → `Dashboard`
- `src/pages/RepeatersPage.tsx` → `RepeatersPage`
- `src/pages/NetsPage.tsx` → `NetsPage`
- `src/pages/RunNetPage.tsx` → `RunNetPage`
- `src/pages/StatsPage.tsx` → `StatsPage`
- `src/pages/AdminPage.tsx` → `AdminPage`

- [ ] **Step 15.7: Create `src/App.tsx`**

```tsx
import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider.js';
import { ThemeProvider, useTheme } from './theme/ThemeProvider.js';
import { RequireRole } from './auth/RequireRole.js';
import { LoginPage } from './auth/LoginPage.js';
import { RegisterPage } from './auth/RegisterPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { Dashboard } from './pages/Dashboard.js';
import { RepeatersPage } from './pages/RepeatersPage.js';
import { NetsPage } from './pages/NetsPage.js';
import { RunNetPage } from './pages/RunNetPage.js';
import { StatsPage } from './pages/StatsPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { Button } from './components/ui/Button.js';

function NavBar() {
  const { user, logout } = useAuth();
  const { current } = useTheme();
  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '12px 20px',
        background: 'var(--color-bg-muted)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <img src={current.logoUrl} alt={current.logo.alt} style={{ height: 36 }} />
      <strong>Ham-Net-Assistant</strong>
      {user && (
        <>
          <Link to="/">Dashboard</Link>
          <Link to="/repeaters">Repeaters</Link>
          <Link to="/nets">Nets</Link>
          <Link to="/stats">Stats</Link>
          <Link to="/settings">Settings</Link>
          {user.role === 'ADMIN' && <Link to="/admin">Admin</Link>}
          <span style={{ marginLeft: 'auto' }}>{user.callsign}</span>
          <Button variant="secondary" onClick={() => logout()}>Sign out</Button>
        </>
      )}
    </nav>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <NavBar />
          <main>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/" element={<RequireRole><Dashboard /></RequireRole>} />
              <Route path="/repeaters" element={<RequireRole><RepeatersPage /></RequireRole>} />
              <Route path="/nets" element={<RequireRole><NetsPage /></RequireRole>} />
              <Route
                path="/run/:sessionId"
                element={
                  <RequireRole min="OFFICER">
                    <RunNetPage />
                  </RequireRole>
                }
              />
              <Route path="/stats" element={<RequireRole><StatsPage /></RequireRole>} />
              <Route path="/settings" element={<RequireRole><SettingsPage /></RequireRole>} />
              <Route
                path="/admin"
                element={
                  <RequireRole min="ADMIN">
                    <AdminPage />
                  </RequireRole>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 15.8: Replace `src/main.tsx`**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/reset.css';
import './styles/theme-vars.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(<App />);
```

- [ ] **Step 15.9: Build — expect PASS**

```bash
cd apps/web && npm run build && npm run typecheck
```

- [ ] **Step 15.10: Commit**

```bash
cd ../..
git add apps/web/src
git commit -m "feat(web): app shell, routing, auth pages, theme picker, stubbed pages"
```

---

## Task 16: Web — Dashboard, Repeaters, Nets pages

**Files:**
- Modify: `src/pages/Dashboard.tsx`, `src/pages/RepeatersPage.tsx`, `src/pages/NetsPage.tsx`
- Create: `src/components/RepeaterCard.tsx`, `src/lib/format.ts`, `src/lib/time.ts`

- [ ] **Step 16.1: Create `src/lib/format.ts`**

```ts
export function formatFrequency(mhz: number): string {
  return `${mhz.toFixed(3)} MHz`;
}
export function formatOffset(khz: number): string {
  if (khz === 0) return 'simplex';
  const sign = khz > 0 ? '+' : '−';
  return `${sign}${Math.abs(khz)} kHz`;
}
export function formatTone(hz: number | null | undefined): string {
  return hz == null ? 'none' : `${hz.toFixed(1)} Hz`;
}
```

- [ ] **Step 16.2: Create `src/lib/time.ts`**

```ts
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayName(d: number): string {
  return DAYS[d] ?? '?';
}

/**
 * Given a Net's dayOfWeek (0-6) and startLocal "HH:mm",
 * return the next occurrence as a JS Date.
 * Wall-clock time is interpreted in the browser's local tz for simplicity.
 */
export function nextOccurrence(dayOfWeek: number, startLocal: string): Date {
  const [h, m] = startLocal.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  const diff = (dayOfWeek - now.getDay() + 7) % 7;
  target.setDate(now.getDate() + diff);
  target.setHours(h ?? 0, m ?? 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 7);
  return target;
}
```

- [ ] **Step 16.3: Create `src/components/RepeaterCard.tsx`**

```tsx
import React from 'react';
import type { Repeater } from '@hna/shared';
import { Card } from './ui/Card.js';
import { formatFrequency, formatOffset, formatTone } from '../lib/format.js';

export function RepeaterCard({
  r,
  onEdit,
  onDelete,
}: {
  r: Repeater;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>{r.name}</h3>
      <div>
        {formatFrequency(r.frequency)} · {formatOffset(r.offsetKhz)} · tone {formatTone(r.toneHz)}
      </div>
      <div>Mode: {r.mode}</div>
      {r.coverage && <p>{r.coverage}</p>}
      {(onEdit || onDelete) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {onEdit && <button onClick={onEdit}>Edit</button>}
          {onDelete && <button onClick={onDelete}>Delete</button>}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 16.4: Replace `src/pages/RepeatersPage.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import type { Repeater, RepeaterInput } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Modal } from '../components/ui/Modal.js';
import { RepeaterCard } from '../components/RepeaterCard.js';
import { useAuth } from '../auth/AuthProvider.js';

const empty: RepeaterInput = {
  name: '',
  frequency: 146.52,
  offsetKhz: 0,
  toneHz: null,
  mode: 'FM',
  coverage: '',
  latitude: null,
  longitude: null,
};

export function RepeatersPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'OFFICER' || user?.role === 'ADMIN';
  const [list, setList] = useState<Repeater[]>([]);
  const [editing, setEditing] = useState<{ id?: string; data: RepeaterInput } | null>(null);

  async function reload() {
    setList(await apiFetch<Repeater[]>('/repeaters'));
  }
  useEffect(() => {
    void reload();
  }, []);

  async function save() {
    if (!editing) return;
    const { id, data } = editing;
    const payload: RepeaterInput = {
      ...data,
      frequency: Number(data.frequency),
      offsetKhz: Number(data.offsetKhz),
    };
    if (id)
      await apiFetch(`/repeaters/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await apiFetch('/repeaters', { method: 'POST', body: JSON.stringify(payload) });
    setEditing(null);
    await reload();
  }

  async function remove(id: string) {
    if (!confirm('Delete this repeater?')) return;
    await apiFetch(`/repeaters/${id}`, { method: 'DELETE' });
    await reload();
  }

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <h1>Repeaters</h1>
        {canEdit && <Button onClick={() => setEditing({ data: empty })}>Add repeater</Button>}
      </div>
      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          marginTop: 16,
        }}
      >
        {list.map((r) => (
          <RepeaterCard
            key={r.id}
            r={r}
            onEdit={canEdit ? () => setEditing({ id: r.id, data: r }) : undefined}
            onDelete={canEdit ? () => remove(r.id) : undefined}
          />
        ))}
      </div>
      <Modal open={editing !== null} onClose={() => setEditing(null)}>
        {editing && (
          <div>
            <h2>{editing.id ? 'Edit repeater' : 'New repeater'}</h2>
            <label>
              Name
              <Input
                value={editing.data.name}
                onChange={(e) =>
                  setEditing({ ...editing, data: { ...editing.data, name: e.target.value } })
                }
              />
            </label>
            <label>
              Frequency (MHz)
              <Input
                type="number"
                step="0.001"
                value={editing.data.frequency}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, frequency: Number(e.target.value) },
                  })
                }
              />
            </label>
            <label>
              Offset (kHz)
              <Input
                type="number"
                value={editing.data.offsetKhz}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, offsetKhz: Number(e.target.value) },
                  })
                }
              />
            </label>
            <label>
              Tone (Hz)
              <Input
                type="number"
                step="0.1"
                value={editing.data.toneHz ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: {
                      ...editing.data,
                      toneHz: e.target.value === '' ? null : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              Mode
              <select
                value={editing.data.mode}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, mode: e.target.value as RepeaterInput['mode'] },
                  })
                }
              >
                <option>FM</option>
                <option>DMR</option>
                <option>D-STAR</option>
                <option>Fusion</option>
              </select>
            </label>
            <label>
              Coverage
              <Input
                value={editing.data.coverage ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, coverage: e.target.value },
                  })
                }
              />
            </label>
            <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
              <Button onClick={save}>Save</Button>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
```

- [ ] **Step 16.5: Replace `src/pages/NetsPage.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Net, NetInput, Repeater } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Modal } from '../components/ui/Modal.js';
import { Card } from '../components/ui/Card.js';
import { useAuth } from '../auth/AuthProvider.js';
import { dayName } from '../lib/time.js';

interface NetWithRepeater extends Net {
  repeater: Repeater;
}

const empty: NetInput = {
  name: '',
  repeaterId: '',
  dayOfWeek: 3,
  startLocal: '20:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  theme: '',
  scriptMd: '',
  active: true,
};

export function NetsPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const canEdit = user?.role === 'OFFICER' || user?.role === 'ADMIN';
  const [nets, setNets] = useState<NetWithRepeater[]>([]);
  const [repeaters, setRepeaters] = useState<Repeater[]>([]);
  const [editing, setEditing] = useState<{ id?: string; data: NetInput } | null>(null);

  async function reload() {
    const [n, r] = await Promise.all([
      apiFetch<NetWithRepeater[]>('/nets'),
      apiFetch<Repeater[]>('/repeaters'),
    ]);
    setNets(n);
    setRepeaters(r);
  }
  useEffect(() => {
    void reload();
  }, []);

  async function save() {
    if (!editing) return;
    const { id, data } = editing;
    if (id) await apiFetch(`/nets/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    else await apiFetch('/nets', { method: 'POST', body: JSON.stringify(data) });
    setEditing(null);
    await reload();
  }

  async function startNet(id: string) {
    const s = await apiFetch<{ id: string }>(`/nets/${id}/sessions`, { method: 'POST' });
    nav(`/run/${s.id}`);
  }

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h1>Nets</h1>
        {canEdit && (
          <Button
            onClick={() =>
              setEditing({
                data: { ...empty, repeaterId: repeaters[0]?.id ?? '' },
              })
            }
          >
            Add net
          </Button>
        )}
      </div>
      <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
        {nets.map((n) => (
          <Card key={n.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: 0 }}>{n.name}</h3>
                <div>
                  {dayName(n.dayOfWeek)} at {n.startLocal} ({n.timezone})
                </div>
                <div>Repeater: {n.repeater.name}</div>
                {n.theme && <div>Theme: {n.theme}</div>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {canEdit && <Button onClick={() => startNet(n.id)}>Start net</Button>}
                {canEdit && (
                  <Button variant="secondary" onClick={() => setEditing({ id: n.id, data: n })}>
                    Edit
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Modal open={editing !== null} onClose={() => setEditing(null)}>
        {editing && (
          <div>
            <h2>{editing.id ? 'Edit net' : 'New net'}</h2>
            <label>
              Name
              <Input
                value={editing.data.name}
                onChange={(e) =>
                  setEditing({ ...editing, data: { ...editing.data, name: e.target.value } })
                }
              />
            </label>
            <label>
              Repeater
              <select
                value={editing.data.repeaterId}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, repeaterId: e.target.value },
                  })
                }
              >
                {repeaters.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Day of week
              <select
                value={editing.data.dayOfWeek}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, dayOfWeek: Number(e.target.value) },
                  })
                }
              >
                {Array.from({ length: 7 }, (_, i) => (
                  <option key={i} value={i}>
                    {dayName(i)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Start time (HH:mm)
              <Input
                value={editing.data.startLocal}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, startLocal: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Theme
              <Input
                value={editing.data.theme ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, theme: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Script (markdown)
              <textarea
                rows={10}
                className="hna-input"
                value={editing.data.scriptMd ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, scriptMd: e.target.value },
                  })
                }
              />
            </label>
            <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
              <Button onClick={save}>Save</Button>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
```

- [ ] **Step 16.6: Replace `src/pages/Dashboard.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import type { Net, Repeater, NetSession } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { dayName, nextOccurrence } from '../lib/time.js';

interface NetWithRepeater extends Net {
  repeater: Repeater;
}

export function Dashboard() {
  const [nets, setNets] = useState<NetWithRepeater[]>([]);
  const [sessions, setSessions] = useState<NetSession[]>([]);
  useEffect(() => {
    void apiFetch<NetWithRepeater[]>('/nets').then(setNets);
    void apiFetch<NetSession[]>('/sessions').then(setSessions);
  }, []);
  const upcoming = [...nets]
    .map((n) => ({ n, when: nextOccurrence(n.dayOfWeek, n.startLocal) }))
    .sort((a, b) => a.when.getTime() - b.when.getTime())
    .slice(0, 3);

  return (
    <div style={{ padding: 24, display: 'grid', gap: 16, maxWidth: 900, margin: '0 auto' }}>
      <Card>
        <h2>Next nets</h2>
        {upcoming.length === 0 && <p>No nets scheduled yet.</p>}
        {upcoming.map(({ n, when }) => (
          <div
            key={n.id}
            style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}
          >
            <span>
              {n.name} — {n.repeater.name}
            </span>
            <span>
              {dayName(when.getDay())} {when.toLocaleString()}
            </span>
          </div>
        ))}
      </Card>
      <Card>
        <h2>Recent sessions</h2>
        {sessions.slice(0, 5).map((s) => (
          <div key={s.id}>
            {new Date(s.startedAt).toLocaleString()} — {s.endedAt ? 'ended' : 'in progress'}
          </div>
        ))}
      </Card>
    </div>
  );
}
```

- [ ] **Step 16.7: Build + typecheck**

```bash
cd apps/web && npm run build && npm run typecheck
```

- [ ] **Step 16.8: Commit**

```bash
cd ../..
git add apps/web/src
git commit -m "feat(web): dashboard, repeaters and nets CRUD pages"
```

---

## Task 17: Web — RunNetPage (centerpiece)

**Files:**
- Modify: `src/pages/RunNetPage.tsx`
- Create: `src/components/ScriptEditor.tsx`

- [ ] **Step 17.1: Create `src/components/ScriptEditor.tsx`**

```tsx
import React from 'react';

export function ScriptEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      className="hna-input"
      style={{ minHeight: 300, width: '100%', fontFamily: 'ui-monospace, Menlo, monospace' }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="# Net script&#10;Welcome to the club net..."
    />
  );
}
```

- [ ] **Step 17.2: Replace `src/pages/RunNetPage.tsx`**

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { Input } from '../components/ui/Input.js';
import { ScriptEditor } from '../components/ScriptEditor.js';
import { formatFrequency, formatOffset, formatTone } from '../lib/format.js';

interface SessionResponse extends NetSession {
  checkIns: CheckIn[];
}
interface NetFull extends Net {
  repeater: Repeater;
}

export function RunNetPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [net, setNet] = useState<NetFull | null>(null);
  const [callsign, setCallsign] = useState('');
  const [name, setName] = useState('');
  const [script, setScript] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function loadSession() {
    if (!sessionId) return;
    const s = await apiFetch<SessionResponse>(`/sessions/${sessionId}`);
    setSession(s);
    const nets = await apiFetch<NetFull[]>('/nets');
    const n = nets.find((x) => x.id === s.netId) ?? null;
    setNet(n);
    if (n?.scriptMd && !script) setScript(n.scriptMd);
  }
  useEffect(() => {
    void loadSession();
  }, [sessionId]); // eslint-disable-line

  async function addCheckIn(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId) return;
    if (!/^[A-Z0-9]{3,7}$/.test(callsign)) return;
    if (!name.trim()) return;
    await apiFetch(`/sessions/${sessionId}/checkins`, {
      method: 'POST',
      body: JSON.stringify({ callsign, nameAtCheckIn: name }),
    });
    setCallsign('');
    setName('');
    inputRef.current?.focus();
    await loadSession();
  }

  async function undoLast() {
    const last = session?.checkIns[0];
    if (!last) return;
    await apiFetch(`/checkins/${last.id}`, { method: 'DELETE' });
    await loadSession();
  }

  async function endNet() {
    if (!sessionId) return;
    if (!confirm('End this net?')) return;
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ endedAt: new Date().toISOString() }),
    });
    nav('/stats');
  }

  if (!session || !net) return <div style={{ padding: 24 }}>Loading session…</div>;

  return (
    <div style={{ display: 'grid', gap: 16, padding: 16, gridTemplateColumns: '1fr 2fr 1fr' }}>
      <Card>
        <h2>{net.repeater.name}</h2>
        <div>{formatFrequency(net.repeater.frequency)}</div>
        <div>Offset: {formatOffset(net.repeater.offsetKhz)}</div>
        <div>Tone: {formatTone(net.repeater.toneHz)}</div>
        <div>Mode: {net.repeater.mode}</div>
        <hr />
        <div>
          Net: <strong>{net.name}</strong>
        </div>
        {net.theme && <div>Theme: {net.theme}</div>}
        <div style={{ marginTop: 16 }}>
          <Button variant="danger" onClick={endNet}>
            End net
          </Button>
        </div>
      </Card>
      <Card>
        <h3>Script</h3>
        <ScriptEditor value={script} onChange={setScript} />
      </Card>
      <Card>
        <h3>Check-ins ({session.checkIns.length})</h3>
        <form onSubmit={addCheckIn}>
          <label>
            Callsign
            <CallsignInput ref={inputRef} value={callsign} onChange={setCallsign} autoFocus />
          </label>
          <label>
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <Button type="submit">Add</Button>
            <Button type="button" variant="secondary" onClick={undoLast}>
              Undo
            </Button>
          </div>
        </form>
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
          {session.checkIns.map((ci) => (
            <li
              key={ci.id}
              style={{ borderBottom: '1px solid var(--color-border)', padding: '4px 0' }}
            >
              <strong>{ci.callsign}</strong> — {ci.nameAtCheckIn}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
```

- [ ] **Step 17.3: Build + typecheck**

```bash
cd apps/web && npm run build && npm run typecheck
```

- [ ] **Step 17.4: Commit**

```bash
cd ../..
git add apps/web/src
git commit -m "feat(web): RunNetPage live check-in flow with script editor"
```

---

## Task 18: Web — Stats and Admin pages

**Files:**
- Modify: `src/pages/StatsPage.tsx`, `src/pages/AdminPage.tsx`

- [ ] **Step 18.1: Replace `src/pages/StatsPage.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { ParticipationStats } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';

export function StatsPage() {
  const [stats, setStats] = useState<ParticipationStats | null>(null);
  useEffect(() => {
    void apiFetch<ParticipationStats>('/stats/participation').then(setStats);
  }, []);

  function download(url: string, filename: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  if (!stats) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto', display: 'grid', gap: 16 }}>
      <Card>
        <h2>Participation</h2>
        <div>
          Range: {stats.range.from.slice(0, 10)} to {stats.range.to.slice(0, 10)}
        </div>
        <div>
          Total sessions: {stats.totalSessions} · Total check-ins: {stats.totalCheckIns}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Button onClick={() => download('/api/stats/export.csv', 'checkins.csv')}>
            Download CSV
          </Button>
          <Button onClick={() => download('/api/stats/export.pdf', 'participation.pdf')}>
            Download PDF
          </Button>
        </div>
      </Card>
      <Card>
        <h3>Check-ins per net</h3>
        <div style={{ height: 280 }}>
          <ResponsiveContainer>
            <BarChart data={stats.perNet}>
              <XAxis dataKey="netName" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="checkIns" fill="var(--color-primary)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card>
        <h3>Top members</h3>
        <ol>
          {stats.perMember.slice(0, 10).map((m) => (
            <li key={m.callsign}>
              {m.callsign} — {m.name}: {m.count}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
```

- [ ] **Step 18.2: Replace `src/pages/AdminPage.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import type { PublicUser, Role } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';

export function AdminPage() {
  const [users, setUsers] = useState<PublicUser[]>([]);

  async function reload() {
    setUsers(await apiFetch<PublicUser[]>('/users'));
  }
  useEffect(() => {
    void reload();
  }, []);

  async function setRole(id: string, role: Role) {
    await apiFetch(`/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
    await reload();
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <h1>Admin</h1>
      <Card>
        <h3>Members</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Callsign</th>
              <th align="left">Name</th>
              <th align="left">Email</th>
              <th align="left">Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td>{u.callsign}</td>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  {(['MEMBER', 'OFFICER', 'ADMIN'] as Role[])
                    .filter((r) => r !== u.role)
                    .map((r) => (
                      <Button key={r} variant="secondary" onClick={() => setRole(u.id, r)}>
                        Make {r.toLowerCase()}
                      </Button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
```

- [ ] **Step 18.3: Build + typecheck**

```bash
cd apps/web && npm run build && npm run typecheck
```

- [ ] **Step 18.4: Commit**

```bash
cd ../..
git add apps/web/src
git commit -m "feat(web): stats page with charts/exports and admin user management"
```

---

## Task 19: API — SPA fallback (serve built web)

**Files:**
- Create: `src/static.ts`
- Modify: `src/app.ts`

- [ ] **Step 19.1: Create `src/static.ts`**

```ts
import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

export function mountStatic(app: Express): void {
  const dir = env.STATIC_DIR || path.resolve(process.cwd(), '../web/dist');
  if (!fs.existsSync(dir)) return;
  app.use(express.static(dir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(dir, 'index.html'));
  });
}
```

- [ ] **Step 19.2: Modify `src/app.ts`**

Add `import { mountStatic } from './static.js';` near the other imports. Inside `buildApp`, insert `mountStatic(app);` immediately before `app.use(errorHandler);`.

- [ ] **Step 19.3: Run typecheck**

```bash
cd apps/api && npm run typecheck
```

- [ ] **Step 19.4: Commit**

```bash
cd ../..
git add apps/api/src
git commit -m "feat(api): serve built SPA as fallback for non-API routes"
```

---

## Task 20: Docker + compose

**Files:**
- Create: `docker/Dockerfile`, `docker-compose.yml`, `.dockerignore`

- [ ] **Step 20.1: Create `.dockerignore`**

```
node_modules
**/node_modules
**/dist
**/build
.git
*.log
apps/api/prisma/dev.db*
data
```

- [ ] **Step 20.2: Create `docker/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Install all workspace deps once
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install

# Build shared, web, api
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
COPY themes themes
RUN npm -w @hna/shared run build
RUN npx -w @hna/api prisma generate
RUN npm -w @hna/api run build
RUN npm -w @hna/web run build

# Runtime: only what we need
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/themes themes
RUN npm install --omit=dev --workspaces --include-workspace-root=false \
    && npx -w @hna/api prisma generate
ENV STATIC_DIR=/app/apps/web/dist
ENV DATABASE_URL=file:/data/ham.db
EXPOSE 3000
CMD ["sh", "-c", "npx -w @hna/api prisma migrate deploy && node apps/api/dist/index.js"]
```

- [ ] **Step 20.3: Create `docker-compose.yml`**

```yaml
services:
  hna:
    build:
      context: .
      dockerfile: docker/Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - hna-data:/data
    environment:
      JWT_SECRET: ${JWT_SECRET:-change-me-change-me-change-me}
      REGISTRATION_CODE: ${REGISTRATION_CODE:-}
      NODE_ENV: production

volumes:
  hna-data:
```

- [ ] **Step 20.4: Verify `docker build` locally**

```bash
docker build -f docker/Dockerfile -t hna:local .
```
Expected: image builds without errors.

- [ ] **Step 20.5: Commit**

```bash
git add docker docker-compose.yml .dockerignore
git commit -m "chore(docker): multi-stage Dockerfile + compose with data volume"
```

---

## Task 21: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 21.1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [master, main]
  pull_request:

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm install
      - run: npm -w @hna/shared run build
      - run: npx -w @hna/api prisma generate
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
        env:
          JWT_SECRET: ci-secret-long-enough-for-validation
      - run: npm run build
        env:
          JWT_SECRET: ci-secret-long-enough-for-validation

  docker:
    runs-on: ubuntu-latest
    needs: build-and-test
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Build image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile
          push: false
          tags: hna:ci
```

- [ ] **Step 21.2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions for lint/typecheck/test/build + docker build"
```

---

## Task 22: README + smoke test + push

**Files:**
- Modify: `README.md`

- [ ] **Step 22.1: Expand `README.md`**

```markdown
# Ham-Net-Assistant

Web app for college amateur-radio clubs to manage repeaters, schedule
weekly nets, run live check-ins, and produce FCC-friendly sign-in logs
and participation statistics for funding requests.

Ships with pickable college themes (K-State, MIT, Georgia Tech,
Virginia Tech, Illinois, plus a neutral default).

## Dev

    npm install
    npm run dev:api    # terminal 1
    npm run dev:web    # terminal 2

Frontend at http://localhost:5173 (proxies /api to :3000).

## Test

    npm test

## Build + run with Docker

    docker compose up --build

Then open http://localhost:3000. First registered user becomes ADMIN.

## Environment

- `JWT_SECRET` (required, >= 16 chars)
- `REGISTRATION_CODE` (optional invite gate)
- `DATABASE_URL` (default `file:/data/ham.db` in docker)
- `PORT` (default 3000)

## Themes

Drop your own `themes/<slug>/logo.svg` to brand the app for your club.
See `themes/README.md` for the trademark note.

## Docs

- Design: `docs/superpowers/specs/2026-04-10-ham-net-assistant-design.md`
- Plan: `docs/superpowers/plans/2026-04-10-ham-net-assistant.md`
```

- [ ] **Step 22.2: Full smoke test**

```bash
npm run build && npm test && docker build -f docker/Dockerfile -t hna:local .
```
Expected: all green.

- [ ] **Step 22.3: Commit**

```bash
git add README.md
git commit -m "docs: README with dev/test/docker instructions"
```

- [ ] **Step 22.4: (When ready) push to GitHub**

```bash
# Create the public repo via github.com UI or gh repo create first.
git remote add origin git@github.com:Atvriders/ham-net-assistant.git
git push -u origin master
```

---

## Spec coverage self-check

- Monorepo, single Docker container, one port → Tasks 1, 19, 20 ✓
- Shared Zod schemas → Task 2 ✓
- Prisma data model (User, Repeater, Net, NetSession, CheckIn; denormalized callsign; nullable visitor userId; scriptMd on Net) → Task 3 ✓
- Auth (argon2, JWT cookie, roles, first-user-ADMIN, invite code gate, callsign regex) → Tasks 4, 5 ✓
- Repeaters CRUD → Task 6 ✓
- Nets CRUD with user-entered script → Task 7 ✓
- Sessions + check-ins with member/officer delete rules → Task 8 ✓
- Stats endpoints, CSV, PDF → Task 9 ✓
- Themes registry endpoint, users admin → Task 10 ✓
- Theme folders: default + kstate + mit + georgiatech + virginiatech + illinois, colors only, empty logo slots, trademark README → Task 11 ✓
- Web scaffold, theme registry via Vite glob, CSS custom props → Tasks 12, 13 ✓
- UI primitives + CallsignInput with tests → Task 14 ✓
- App shell, router, auth pages, role gating, theme picker, settings → Task 15 ✓
- Dashboard, Repeaters, Nets pages → Task 16 ✓
- RunNetPage centerpiece with script editor, visitor check-in, undo, end → Task 17 ✓
- Stats page with Recharts + CSV/PDF download, Admin page with role change → Task 18 ✓
- SPA fallback in API → Task 19 ✓
- Dockerfile + compose + volume → Task 20 ✓
- CI workflow → Task 21 ✓
- README → Task 22 ✓

**Gaps:** none against the spec.

## Notes on deferred items (per spec "Out of Scope")

- Auto-generated net scripts — not implemented (user enters their own).
- FCC ULS lookup — not implemented.
- Playwright E2E — not implemented.
- Real-time websocket multi-operator sync — not implemented.
- Email notifications — not implemented.
