import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
// helpers.ts installs a valid JWT_SECRET as a side effect. src/env.ts parses
// process.env at import time, so without this the import below throws.
import './helpers.js';
import { Env, formatEnvError, isPlaceholderSecret } from '../src/env.js';

const STRONG = '5b8f2c9a1e47d306fb92a5c8e10d47b6f3a9c25d80e1b74f6a3c95d2e807b1f4';

function parseSecret(secret: string) {
  return Env.safeParse({ JWT_SECRET: secret });
}

describe('JWT_SECRET validation', () => {
  it('accepts a 64-char random hex secret', () => {
    const parsed = parseSecret(STRONG);
    expect(parsed.success).toBe(true);
  });

  it('rejects a secret shorter than 32 chars', () => {
    const parsed = parseSecret('a1b2c3d4e5f60718');
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0].message).toContain('openssl rand -hex 32');
  });

  it('rejects the docker-compose placeholder even though it passed min(16)', () => {
    // The exact string shipped in the public repo's compose file.
    const parsed = parseSecret('change-me-change-me-change-me');
    expect(parsed.success).toBe(false);
  });

  it('rejects a long secret that still contains a placeholder marker', () => {
    // 40 chars — long enough for min(32), so only the denylist catches it.
    const parsed = parseSecret('change-me-change-me-change-me-change-me-');
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0].message).toContain('openssl rand -hex 32');
  });

  it.each([
    'CHANGE-ME-0000000000000000000000000000000',
    'ChangeMe00000000000000000000000000000000',
    'my-super-SECRET-value-0000000000000000000',
    'please-change-0000000000000000000000000000',
    'EXAMPLE-key-000000000000000000000000000000',
  ])('rejects placeholder-looking secret %s regardless of case', (secret) => {
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(parseSecret(secret).success).toBe(false);
  });

  it('flags placeholders case-insensitively', () => {
    expect(isPlaceholderSecret('Change-Me')).toBe(true);
    expect(isPlaceholderSecret('SECRET')).toBe(true);
    expect(isPlaceholderSecret(STRONG)).toBe(false);
  });
});

describe('formatEnvError', () => {
  it('renders a single line naming the variable and the fix', () => {
    const parsed = parseSecret('short');
    const line = formatEnvError(parsed.error!);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('JWT_SECRET');
    expect(line).toContain('openssl rand -hex 32');
  });
});

describe('other env defaults', () => {
  it('keeps working defaults so only JWT_SECRET is mandatory', () => {
    const parsed = Env.parse({ JWT_SECRET: STRONG });
    expect(parsed.PORT).toBe(3000);
    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.DATABASE_URL).toBe('file:./dev.db');
  });
});

/**
 * The schema tests above prove the RULES; these prove the CONSEQUENCE, which is
 * the actual protection: a production container configured with the compose
 * placeholder must die instead of booting with a signing key that is published
 * in this repository. That behavior is a module-level side effect of importing
 * src/env.ts (writeSync + process.exit), so it can only be observed from a
 * child process — same approach as shutdown.test.ts.
 */
describe('loadEnv production behavior', () => {
  // `node --import tsx`, not the tsx CLI: the CLI re-spawns node, which would
  // put a wrapper process between us and the exit code we are asserting on.
  const probe = path.join(import.meta.dirname, 'fixtures', 'envProbe.ts');

  function runWithSecret(secret: string | undefined) {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
    if (secret === undefined) delete env.JWT_SECRET;
    else env.JWT_SECRET = secret;
    return spawnSync(process.execPath, ['--import', 'tsx', probe], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
  }

  it('exits non-zero with an actionable message on the compose placeholder', () => {
    const run = runWithSecret('change-me-change-me-change-me');
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('BOOTED');
    expect(run.stderr).toContain('JWT_SECRET');
    expect(run.stderr).toContain('openssl rand -hex 32');
  });

  it('exits non-zero when JWT_SECRET is unset entirely', () => {
    const run = runWithSecret(undefined);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('BOOTED');
  });

  it('boots when the secret is genuinely random', () => {
    const run = runWithSecret(STRONG);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('BOOTED');
  });
});
