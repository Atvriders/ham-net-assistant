import fs from 'node:fs';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { RegisterInput, ROLE_LABEL, Role } from '@hna/shared';
import { hashPassword } from '../lib/password.js';
import { resolveSqliteFile, prismaDirFrom, isDirectRun } from './sqlitePath.js';

/**
 * Operator recovery CLI.
 *
 * WHY this exists: every club's ADMIN is a student who eventually graduates,
 * loses the password, or hands the club over by word of mouth. The app has no
 * self-service password reset, the first-user-becomes-ADMIN bootstrap only
 * fires on an empty database, and the runtime image deliberately ships without
 * the sqlite3 CLI. Without this file, "get back into the club account" means
 * hand-writing a Node script inside a running container against the only copy
 * of the club's net logs.
 *
 * Run it inside the running container, as the app user:
 *
 *   docker compose exec -u hna hna node apps/api/dist/cli/admin.js list-admins
 *   docker compose exec -u hna hna node apps/api/dist/cli/admin.js promote a@b.c
 *   docker compose exec -u hna hna node apps/api/dist/cli/admin.js set-password a@b.c
 *
 * `-u hna` matters: running as root against a WAL database can leave
 * root-owned ham.db-wal / ham.db-shm sidecars behind that the service (which
 * runs as hna) can then no longer write to.
 */

/** Injected so tests can assert output and feed a password without a TTY. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Must never echo what it reads. */
  readSecret(prompt: string): Promise<string>;
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** Distinct code so an orchestration script can tell "wrong DB" from "no admin". */
export const EXIT_NO_DATABASE = 2;

export const USAGE = `Ham-Net-Assistant admin recovery CLI

Usage:
  node apps/api/dist/cli/admin.js list-admins
  node apps/api/dist/cli/admin.js promote <email>
  node apps/api/dist/cli/admin.js set-password <email>

Commands:
  list-admins           List every account holding the ADMIN role.
  promote <email>       Grant ADMIN to an existing account.
  set-password <email>  Replace an account's password (prompted, never echoed;
                        pipe it on stdin for scripted use).

Inside the deployment:
  docker compose exec -u hna hna node apps/api/dist/cli/admin.js list-admins

Exit codes: 0 ok, 1 error, 2 no database found.`;

interface UserRow {
  id: string;
  email: string;
  name: string;
  callsign: string;
  role: string;
}

const USER_FIELDS = {
  id: true,
  email: true,
  name: true,
  callsign: true,
  role: true,
} as const;

/** Roles are free-form strings in SQLite, so a DB value may not be a known role. */
function roleLabel(raw: string): string {
  const parsed = Role.safeParse(raw);
  return parsed.success ? ROLE_LABEL[parsed.data] : `${raw} (unknown role)`;
}

/**
 * Exact lookup first (that is how the login route matches), then a
 * case-insensitive fallback used ONLY to suggest the real address. Emails are
 * stored as typed at registration, and "it says no such user but I know that's
 * my email" is the single most likely dead end for whoever is doing the
 * recovery.
 */
async function findUser(prisma: PrismaClient, email: string, io: CliIo): Promise<UserRow | null> {
  const exact = await prisma.user.findUnique({ where: { email }, select: USER_FIELDS });
  if (exact) return exact;
  // SQLite LIKE is case-insensitive for ASCII, which is what Prisma's
  // `contains` compiles to on this provider (`mode: 'insensitive'` is not
  // supported here).
  const near = await prisma.user.findFirst({
    where: { email: { contains: email } },
    select: USER_FIELDS,
  });
  io.err(`No account with email "${email}".`);
  if (near) io.err(`Did you mean "${near.email}"? Email matching is case-sensitive.`);
  else io.err('Run `list-admins` to see the accounts that currently hold ADMIN.');
  return null;
}

async function listAdmins(prisma: PrismaClient, io: CliIo): Promise<number> {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN' },
    select: USER_FIELDS,
    orderBy: { email: 'asc' },
  });
  if (admins.length === 0) {
    io.out('No ADMIN accounts exist.');
    io.out('Grant one with: promote <email>');
    return EXIT_OK;
  }
  io.out(`${admins.length} ADMIN account(s):`);
  for (const a of admins) io.out(`  ${a.email}  ${a.callsign}  ${a.name}`);
  return EXIT_OK;
}

async function promote(prisma: PrismaClient, email: string, io: CliIo): Promise<number> {
  const user = await findUser(prisma, email, io);
  if (!user) return EXIT_ERROR;
  if (user.role === 'ADMIN') {
    io.out(`${user.email} is already ADMIN — no change.`);
    return EXIT_OK;
  }
  await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
  io.out(`Promoted ${user.email} (${user.callsign}) from ${roleLabel(user.role)} to Admin.`);
  // The API re-reads the role from this row on every request (middleware/auth.ts
  // `loadUser`), so the new permissions are live immediately — no re-login. The
  // web client, however, caches the account it fetched from /auth/me when the
  // page loaded, so an already-open tab keeps showing the member menu until it
  // is reloaded. Saying exactly that prevents the classic "the CLI said it
  // worked but nothing changed" support loop.
  io.out('Effective immediately on the API. If they have the app open, they must');
  io.out('reload the page for the admin menu to appear.');
  return EXIT_OK;
}

async function setPassword(prisma: PrismaClient, email: string, io: CliIo): Promise<number> {
  const user = await findUser(prisma, email, io);
  if (!user) return EXIT_ERROR;

  const password = await io.readSecret(`New password for ${user.email}: `);
  const check = RegisterInput.shape.password.safeParse(password);
  if (!check.success) {
    // Same rule the registration form enforces, imported rather than repeated
    // so the CLI cannot drift into accepting a password the app would reject.
    io.err(`Password rejected: ${check.error.issues.map((i) => i.message).join('; ')}`);
    return EXIT_ERROR;
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  // Deliberately no echo of the password (not even masked) — this output ends
  // up in scrollback and, via `docker compose logs`, on disk.
  io.out(`Password updated for ${user.email} (${roleLabel(user.role)}).`);
  // Changing the password does NOT invalidate cookies already in circulation:
  // the session JWT carries no password material. It expires on its own after
  // lib/jwt.ts's TOKEN_TTL_SECONDS (12 hours); rotating JWT_SECRET is the only
  // way to kill every session at once. Quote the real number — an operator
  // acting on a compromise needs to know how long the attacker keeps access.
  io.out('Existing login sessions stay valid for up to 12 hours; if this account');
  io.out('was compromised, also change JWT_SECRET to invalidate every session.');
  return EXIT_OK;
}

/**
 * Dispatch a single command. Prisma is injected so tests drive real SQL
 * against a migrated temp database instead of mocking the client.
 */
export async function runAdminCommand(
  prisma: PrismaClient,
  argv: string[],
  io: CliIo,
): Promise<number> {
  const [command, email, ...rest] = argv;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return command === undefined ? EXIT_ERROR : EXIT_OK;
  }

  if (command === 'list-admins') {
    if (email !== undefined) {
      io.err('list-admins takes no arguments.');
      return EXIT_ERROR;
    }
    return listAdmins(prisma, io);
  }

  if (command !== 'promote' && command !== 'set-password') {
    io.err(`Unknown command "${command}".`);
    io.err(USAGE);
    return EXIT_ERROR;
  }

  if (email === undefined || email.trim() === '') {
    io.err(`${command} requires an email address.`);
    io.err(`  node apps/api/dist/cli/admin.js ${command} someone@example.edu`);
    return EXIT_ERROR;
  }

  if (rest.length > 0) {
    if (command === 'set-password') {
      // Refusing the argv form is the point: process arguments are visible to
      // every user on the host via `ps`, land in shell history, and are echoed
      // by `docker compose exec` in CI logs.
      io.err('Refusing to read a password from the command line (it would be');
      io.err('visible in `ps` output and shell history). You will be prompted,');
      io.err("or pipe it: printf '%s' 'new-password' | ... set-password <email>");
    } else {
      io.err(`${command} takes exactly one argument.`);
    }
    return EXIT_ERROR;
  }

  return command === 'promote' ? promote(prisma, email, io) : setPassword(prisma, email, io);
}

/**
 * TTY: prompt with echo suppressed and confirm. Non-TTY (piped stdin): read
 * the whole stream. Only a single trailing newline is stripped — the rest of
 * the bytes are the password, including any spaces the operator chose.
 */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  const first = await promptHidden(prompt);
  const again = await promptHidden('Repeat password: ');
  if (first !== again) throw new Error('Passwords did not match');
  return first;
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    // readline echoes typed characters by writing them to `output`; pointing
    // output at a sink that discards everything is what hides the password.
    const sink = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: sink, terminal: true });
    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      reject(new Error('cancelled'));
    });
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function describe(e: unknown): string {
  // A ZodError stringifies to a multi-line JSON dump; in a container log that
  // is exactly the shape operators skim past. Render one issue per clause.
  if (e instanceof ZodError) {
    return e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Warn (never block) when the effective user cannot own what SQLite is about
 * to create. Blocking here would be self-defeating — this is the tool of last
 * resort — but a root-created ham.db-wal that the service cannot write is a
 * failure mode worth spelling out before it happens.
 */
function warnOnOwnershipMismatch(dbFile: string, io: CliIo): void {
  if (process.getuid === undefined || process.getuid() !== 0) return;
  try {
    const owner = fs.statSync(dbFile).uid;
    if (owner === 0) return;
    io.err('Warning: running as root against a database owned by another user.');
    io.err('SQLite may leave root-owned -wal/-shm files the service cannot write.');
    io.err('Prefer: docker compose exec -u hna hna node apps/api/dist/cli/admin.js ...');
  } catch {
    /* stat failure is reported by the caller's own checks */
  }
}

async function main(): Promise<number> {
  const io: CliIo = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readSecret,
  };

  // Loaded dynamically so an invalid environment produces an instruction
  // instead of a raw ZodError stack from module-evaluation time.
  let databaseUrl: string;
  try {
    const { env } = await import('../env.js');
    databaseUrl = env.DATABASE_URL;
  } catch (e) {
    io.err(`Environment is invalid: ${describe(e)}`);
    io.err('Run this inside the running container so the service environment applies:');
    io.err('  docker compose exec -u hna hna node apps/api/dist/cli/admin.js list-admins');
    return EXIT_ERROR;
  }

  // Refuse to run without a database. Prisma would otherwise happily create an
  // empty SQLite file and report "no ADMIN accounts exist" — which reads like
  // a diagnosis instead of what it is: the wrong DATABASE_URL.
  const dbFile = resolveSqliteFile(databaseUrl, prismaDirFrom(import.meta.url));
  if (dbFile && !fs.existsSync(dbFile)) {
    io.err(`No database found at ${dbFile} (DATABASE_URL=${databaseUrl}).`);
    io.err('Start the service once so migrations create it, or check that the');
    io.err('hna-data volume is mounted at /data.');
    return EXIT_NO_DATABASE;
  }
  if (dbFile) warnOnOwnershipMismatch(dbFile, io);

  // Same client the server uses, including the SQLite pragmas — busy_timeout
  // in particular, so a write from this CLI waits for the live server's lock
  // instead of failing with SQLITE_BUSY mid-recovery.
  const { prisma, initDb } = await import('../db.js');
  await initDb();
  try {
    return await runAdminCommand(prisma, process.argv.slice(2), io);
  } finally {
    await prisma.$disconnect();
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
      // A prompt leaves stdin resumed; release it so the process can exit
      // rather than process.exit(), which can truncate piped output.
      process.stdin.pause();
    },
    (e: unknown) => {
      console.error(`admin: ${describe(e)}`);
      process.exitCode = EXIT_ERROR;
      process.stdin.pause();
    },
  );
}
