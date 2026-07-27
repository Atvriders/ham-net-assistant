import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeTestDb, cleanupTestDb } from '../helpers.js';
import { runAdminCommand, EXIT_OK, EXIT_ERROR, type CliIo } from '../../src/cli/admin.js';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';

// The recovery CLI is the club's ONLY route back into an account once the
// student admin graduates — it has to behave predictably at 2am, and it must
// never leak the password it just set into a terminal scrollback or
// `docker compose logs`.

let prisma: PrismaClient;
let dbFile: string;

/** Records everything the CLI printed so tests can assert what leaked. */
function makeIo(secret = 'brand-new-password'): CliIo & {
  out: (l: string) => void;
  lines: string[];
  errors: string[];
  secretReads: number;
} {
  const lines: string[] = [];
  const errors: string[] = [];
  const io = {
    lines,
    errors,
    secretReads: 0,
    out: (l: string) => void lines.push(l),
    err: (l: string) => void errors.push(l),
    readSecret: async (): Promise<string> => {
      io.secretReads += 1;
      return secret;
    },
  };
  return io;
}

async function makeUser(email: string, role: string, password = 'hunter2hunter2') {
  return prisma.user.create({
    data: {
      email,
      name: 'Test User',
      callsign: 'W1AW',
      passwordHash: await hashPassword(password),
      role,
    },
  });
}

beforeAll(() => {
  ({ prisma, dbFile } = makeTestDb());
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});
beforeEach(async () => {
  await prisma.user.deleteMany();
});

describe('admin CLI: list-admins', () => {
  it('points at the fix when the club has no admin left', async () => {
    await makeUser('member@x.co', 'MEMBER');
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['list-admins'], io)).toBe(EXIT_OK);
    expect(io.lines.join('\n')).toMatch(/No ADMIN accounts exist/);
    expect(io.lines.join('\n')).toMatch(/promote <email>/);
  });

  it('lists admins only', async () => {
    await makeUser('a@x.co', 'ADMIN');
    await makeUser('b@x.co', 'OFFICER');
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['list-admins'], io)).toBe(EXIT_OK);
    const out = io.lines.join('\n');
    expect(out).toMatch(/a@x\.co/);
    expect(out).not.toMatch(/b@x\.co/);
  });

  it('rejects stray arguments', async () => {
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['list-admins', 'a@x.co'], io)).toBe(EXIT_ERROR);
  });
});

describe('admin CLI: promote', () => {
  it('grants ADMIN and tells the operator the UI needs a reload', async () => {
    await makeUser('m@x.co', 'MEMBER');
    const io = makeIo();

    expect(await runAdminCommand(prisma, ['promote', 'm@x.co'], io)).toBe(EXIT_OK);

    const after = await prisma.user.findUnique({ where: { email: 'm@x.co' } });
    expect(after?.role).toBe('ADMIN');
    // The API reads the role from the DB on every request, so the grant is
    // live at once — but AuthProvider caches /auth/me for the life of the
    // page, so an open tab still shows the member menu. The CLI must say
    // "reload", not "log out and back in" (which was true only while the role
    // travelled inside the JWT).
    expect(io.lines.join('\n')).toMatch(/reload the page/i);
    expect(io.lines.join('\n')).not.toMatch(/log out and log back in/);
  });

  it('is idempotent for an existing admin', async () => {
    await makeUser('a@x.co', 'ADMIN');
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['promote', 'a@x.co'], io)).toBe(EXIT_OK);
    expect(io.lines.join('\n')).toMatch(/already ADMIN/);
  });

  it('suggests the real address when only the case differs', async () => {
    await makeUser('Dean@x.co', 'MEMBER');
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['promote', 'dean@x.co'], io)).toBe(EXIT_ERROR);
    expect(io.errors.join('\n')).toMatch(/Did you mean "Dean@x\.co"/);
  });

  it('fails with an actionable message for an unknown account', async () => {
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['promote', 'ghost@x.co'], io)).toBe(EXIT_ERROR);
    expect(io.errors.join('\n')).toMatch(/No account with email "ghost@x\.co"/);
    expect(io.errors.join('\n')).toMatch(/list-admins/);
  });

  it('requires an email', async () => {
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['promote'], io)).toBe(EXIT_ERROR);
    expect(io.errors.join('\n')).toMatch(/requires an email/);
  });
});

describe('admin CLI: set-password', () => {
  it('stores an argon2 hash of the prompted password and never echoes it', async () => {
    await makeUser('a@x.co', 'ADMIN', 'old-password-123');
    const io = makeIo('recovered-password-9');

    expect(await runAdminCommand(prisma, ['set-password', 'a@x.co'], io)).toBe(EXIT_OK);

    const after = await prisma.user.findUnique({ where: { email: 'a@x.co' } });
    expect(after!.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(after!.passwordHash, 'recovered-password-9')).toBe(true);
    expect(await verifyPassword(after!.passwordHash, 'old-password-123')).toBe(false);
    // Nothing the CLI prints may contain the secret — this output survives in
    // scrollback and in `docker compose logs`.
    expect([...io.lines, ...io.errors].join('\n')).not.toMatch(/recovered-password-9/);
  });

  it('warns that existing sessions stay valid', async () => {
    await makeUser('a@x.co', 'ADMIN');
    const io = makeIo();
    await runAdminCommand(prisma, ['set-password', 'a@x.co'], io);
    expect(io.lines.join('\n')).toMatch(/JWT_SECRET/);
  });

  it('applies the app’s own password rule and leaves the hash untouched', async () => {
    const user = await makeUser('a@x.co', 'ADMIN');
    const io = makeIo('short');

    expect(await runAdminCommand(prisma, ['set-password', 'a@x.co'], io)).toBe(EXIT_ERROR);

    const after = await prisma.user.findUnique({ where: { email: 'a@x.co' } });
    expect(after!.passwordHash).toBe(user.passwordHash);
    expect(io.errors.join('\n')).toMatch(/Password rejected/);
  });

  it('refuses a password passed as an argument, before reading anything', async () => {
    await makeUser('a@x.co', 'ADMIN');
    const io = makeIo();

    expect(await runAdminCommand(prisma, ['set-password', 'a@x.co', 'oops-secret'], io)).toBe(
      EXIT_ERROR,
    );

    // `ps` and shell history would both capture it.
    expect(io.errors.join('\n')).toMatch(/Refusing to read a password from the command line/);
    expect(io.secretReads).toBe(0);
  });

  it('does not touch an unknown account', async () => {
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['set-password', 'ghost@x.co'], io)).toBe(EXIT_ERROR);
    expect(io.secretReads).toBe(0);
  });
});

describe('admin CLI: usage', () => {
  it('prints usage and fails when invoked with no command', async () => {
    const io = makeIo();
    expect(await runAdminCommand(prisma, [], io)).toBe(EXIT_ERROR);
    expect(io.lines.join('\n')).toMatch(/Usage:/);
  });

  it('prints usage and succeeds for help', async () => {
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['help'], io)).toBe(EXIT_OK);
    expect(io.lines.join('\n')).toMatch(/list-admins/);
  });

  it('names the unknown command', async () => {
    const io = makeIo();
    expect(await runAdminCommand(prisma, ['delete-everything'], io)).toBe(EXIT_ERROR);
    expect(io.errors.join('\n')).toMatch(/Unknown command "delete-everything"/);
  });
});
