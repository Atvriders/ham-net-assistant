import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The API runs as PID 1 in its container, so nothing reaps signals for it.
 * Without a SIGTERM handler every `docker compose up -d` burned the full
 * 10s stop grace and then SIGKILLed the process — the Discord websocket was
 * never destroyed and SQLite was closed by force. This drives the real
 * entrypoint end to end because the handler only exists as a process-level
 * side effect; there is nothing importable to unit-test.
 */
const apiDir = path.resolve(import.meta.dirname, '..');

function migratedDb(): string {
  const dbFile = path.join(
    apiDir,
    `test-shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: 'ignore',
  });
  return dbFile;
}

function removeDb(dbFile: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* ignore */ }
  }
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  elapsedMs: number;
}

/** Boot src/index.ts, wait until it is listening, then send `signal`. */
async function bootAndSignal(signal: NodeJS.Signals): Promise<RunResult> {
  const dbFile = migratedDb();
  // A port in the ephemeral range; env.PORT rejects 0, so we can't ask the OS.
  const port = 34000 + Math.floor(Math.random() * 1000);
  // `node --import tsx` rather than the `tsx` CLI: the CLI re-spawns node as
  // a grandchild, so child.kill() would signal the launcher instead of the
  // server we're trying to observe.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: apiDir,
    env: {
      ...process.env,
      DATABASE_URL: `file:${dbFile}`,
      // A real-looking random-hex key: env.ts rejects both short values and
      // anything that reads like a placeholder from the example config.
      JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      NODE_ENV: 'test',
      PORT: String(port),
      DISCORD_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { output += d.toString(); });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.on('exit', (code, sig) => resolve({ code, signal: sig })),
  );

  try {
    // Wait for the listen callback rather than a fixed sleep — tsx's startup
    // cost varies wildly between a warm and a cold machine.
    const deadline = Date.now() + 25_000;
    while (!output.includes('listening on') && Date.now() < deadline) {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toContain('listening on');

    const sentAt = Date.now();
    child.kill(signal);
    const { code, signal: exitSignal } = await exited;
    return { code, signal: exitSignal, output, elapsedMs: Date.now() - sentAt };
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    removeDb(dbFile);
  }
}

describe('graceful shutdown', () => {
  it('exits 0 promptly on SIGTERM and logs each drain step', async () => {
    const res = await bootAndSignal('SIGTERM');

    // Exit code 0 via our handler — NOT killed by the signal itself, which is
    // what "no handler installed" looks like.
    expect(res.signal).toBeNull();
    expect(res.code).toBe(0);
    // Comfortably inside Docker's default 10s stop grace.
    expect(res.elapsedMs).toBeLessThan(8_000);

    expect(res.output).toContain('[shutdown] SIGTERM received');
    expect(res.output).toContain('[shutdown] http server closed');
    expect(res.output).toContain('[shutdown] schedulers stopped');
    expect(res.output).toContain('[shutdown] discord client destroyed');
    expect(res.output).toContain('[shutdown] database disconnected');
    // The 8s force-exit backstop must not have been the thing that ended us.
    expect(res.output).not.toContain('forcing exit');
    // Booting the real entrypoint through tsx is slow on a cold CI runner,
    // well past the 30s default.
  }, 90_000);

  it('handles SIGINT the same way (Ctrl-C in local dev)', async () => {
    const res = await bootAndSignal('SIGINT');
    expect(res.code).toBe(0);
    expect(res.output).toContain('[shutdown] SIGINT received');
  }, 90_000);
});
