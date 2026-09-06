import fs from 'node:fs';
import { z } from 'zod';

/**
 * How to generate a real JWT_SECRET. Repeated verbatim in every rejection
 * message so an operator staring at a crashed container has the fix in front
 * of them instead of having to find the README.
 */
const SECRET_HOWTO = 'generate one with: openssl rand -hex 32';

/**
 * Substrings that mark a secret as "whatever the example config said".
 *
 * The shipped docker-compose placeholder is 28 characters of `change-me...`,
 * which passed the old `min(16)` check — so a deploy that never touched the
 * env file booted clean while anyone who can read the public repo could sign
 * themselves an ADMIN cookie. Length alone cannot catch that; the value has
 * to be rejected by name.
 *
 * No false-positive risk for the documented generator: `openssl rand -hex 32`
 * emits only [0-9a-f], and none of these markers are spellable in hex.
 */
const PLACEHOLDER_MARKERS = ['change-me', 'changeme', 'secret', 'please-change', 'example'];

/** True when `value` contains any known placeholder marker (case-insensitive). */
export function isPlaceholderSecret(value: string): boolean {
  const lowered = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Default source for the weekly amateur-licence refresh: the FCC's own
 * "complete" weekly dump. Hard-coded rather than assembled from parts so the
 * host can never be influenced by configuration the app itself computes.
 */
export const DEFAULT_ULS_SOURCE_URL =
  'https://data.fcc.gov/download/pub/uls/complete/l_amat.zip';

/**
 * `z.coerce.number()` reads an empty string as 0, so a `.env` line left blank
 * (`ULS_IMPORT_DAY=`) would silently mean "Sunday" instead of "use the
 * default". Blank and unset must behave identically for every optional
 * numeric var.
 */
function optionalNumber(): z.ZodType<number | undefined, unknown> {
  return z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().optional(),
  ) as z.ZodType<number | undefined, unknown>;
}

/** Env booleans: anything but an explicit off-word counts as on. */
function envFlag(defaultOn: boolean): z.ZodType<boolean, unknown> {
  return z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z
      .string()
      .optional()
      .transform((v) => (v === undefined ? defaultOn : !/^(0|false|no|off)$/i.test(v.trim()))),
  ) as z.ZodType<boolean, unknown>;
}

export const Env = z.object({
  DATABASE_URL: z.string().default('file:./dev.db'),
  JWT_SECRET: z
    .string()
    // 32 chars ~= the 256-bit key size HS256 is specified for. Shorter keys are
    // brute-forceable offline from a single captured cookie.
    .min(32, `JWT_SECRET must be >= 32 chars — ${SECRET_HOWTO}`)
    .refine(
      (value) => !isPlaceholderSecret(value),
      `JWT_SECRET looks like a placeholder from the example config — ${SECRET_HOWTO}`,
    ),
  REGISTRATION_CODE: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  STATIC_DIR: z.string().default(''),

  // ── FCC ULS local mirror (see lib/ulsImport.ts, lib/ulsScheduler.ts) ───────

  /**
   * Master switch for the weekly FCC ULS import. Default ON.
   *
   * COST, so nobody is surprised: each run streams roughly 155 MB from
   * data.fcc.gov (the l_amat.zip complete dump is ~190 MB; we abort the
   * transfer once HD.dat has gone past, which is the last member we need) and
   * writes ~800,000 rows into the club's SQLite file — about 90 MB of table
   * plus index. It runs once a week, in the small hours, in ~2,000-row
   * transactions that yield between batches so a net is never locked out.
   *
   * Set ULS_IMPORT_ENABLED=false on a metered connection, a tiny disk, or if
   * the club is happy depending on callook.info. With it off, callsign lookups
   * behave exactly as they did before this feature existed.
   */
  ULS_IMPORT_ENABLED: envFlag(true),

  /**
   * Override the archive URL — a pinned older dump, or a public mirror closer
   * to the club.
   *
   * It is fetched through the app's one SSRF-guarded outbound path
   * (lib/safeFetch.ts), which refuses private and link-local addresses. That
   * means a mirror on the club's own LAN will NOT work: the host has to be
   * publicly routable. Keeping a single outbound policy is worth more than the
   * LAN-mirror case, so this is deliberate rather than an oversight.
   *
   * Blank = the FCC default.
   */
  ULS_SOURCE_URL: z
    .string()
    .default('')
    .transform((v) => v.trim() || DEFAULT_ULS_SOURCE_URL)
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'ULS_SOURCE_URL must be an http(s) URL'),

  /**
   * Day of week to refresh, 0 = Sunday … 6 = Saturday. Default 5 (Friday).
   * Evaluated in the CONTAINER's local time, which is UTC unless you set TZ.
   */
  ULS_IMPORT_DAY: optionalNumber()
    .refine((v) => v === undefined || (Number.isInteger(v) && v >= 0 && v <= 6),
      'ULS_IMPORT_DAY must be an integer 0-6 (0 = Sunday)')
    .transform((v) => v ?? 5),

  /**
   * Hour of that day, 0-23, at or after which the refresh may start. Default 3
   * (03:00) — off-peak for a club, and after the FCC has published the week's
   * file. Also container-local time.
   */
  ULS_IMPORT_HOUR: optionalNumber()
    .refine((v) => v === undefined || (Number.isInteger(v) && v >= 0 && v <= 23),
      'ULS_IMPORT_HOUR must be an integer 0-23')
    .transform((v) => v ?? 3),
});
export type Env = z.infer<typeof Env>;

/**
 * One-line, log-friendly rendering of a failed env parse. A ZodError's default
 * stringification is a multi-line JSON dump that gets truncated or interleaved
 * in container logs, which is how a bad secret goes unnoticed.
 */
export function formatEnvError(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return `FATAL: invalid environment — ${issues}`;
}

function loadEnv(): Env {
  const parsed = Env.safeParse(process.env);
  if (parsed.success) return parsed.data;
  if (process.env.NODE_ENV === 'production') {
    // A production container must die loudly and stay dead: booting a
    // half-configured server (forgeable admin tokens) is worse than being
    // down, and the restart loop is what makes the operator read the log.
    //
    // writeSync, not console.error: stderr is a pipe under Docker, where
    // Node's writes are asynchronous — process.exit() can discard the very
    // message the operator needs, leaving a container that dies silently.
    fs.writeSync(2, `${formatEnvError(parsed.error)}\n`);
    process.exit(1);
  }
  // Dev/test keep the raw ZodError — it carries the full issue list and is
  // what the test suite asserts against.
  throw parsed.error;
}

export const env = loadEnv();
