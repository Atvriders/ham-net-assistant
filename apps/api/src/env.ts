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
