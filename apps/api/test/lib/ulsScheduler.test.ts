import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeTestDb, cleanupTestDb } from '../helpers.js';
import {
  ULS_RETRY_COOLDOWN_MS,
  ULS_SUCCESS_INTERVAL_MS,
  startUlsImportScheduler,
  ulsImportTick,
  type UlsSchedulerConfig,
} from '../../src/lib/ulsScheduler.js';
import type { UlsImportSummary } from '../../src/lib/ulsImport.js';

let prisma: PrismaClient;
let dbFile: string;

beforeAll(() => {
  ({ prisma, dbFile } = makeTestDb());
});
afterAll(async () => {
  await cleanupTestDb(prisma, dbFile);
});
beforeEach(async () => {
  await prisma.ulsImportRun.deleteMany();
});

const CONFIG: UlsSchedulerConfig = {
  enabled: true,
  url: 'https://example.test/l_amat.zip',
  day: 5, // Friday
  hour: 3,
};

/**
 * Local-time constructors throughout: the scheduler deliberately reads
 * `getDay()`/`getHours()`, i.e. the container's own clock, so a test that built
 * instants from UTC strings would pass or fail depending on the machine's TZ.
 *
 * 2026-09-04 is a Friday (the FCC dump used elsewhere in these tests is stamped
 * "Sun Aug 30 2026", five days earlier).
 */
const FRIDAY_0300 = new Date(2026, 8, 4, 3, 0, 0);
const FRIDAY_0230 = new Date(2026, 8, 4, 2, 30, 0);
const FRIDAY_2300 = new Date(2026, 8, 4, 23, 0, 0);
const THURSDAY_0300 = new Date(2026, 8, 3, 3, 0, 0);
const SATURDAY_0300 = new Date(2026, 8, 5, 3, 0, 0);

it('the fixture instants really are the weekdays they claim', () => {
  expect(THURSDAY_0300.getDay()).toBe(4);
  expect(FRIDAY_0300.getDay()).toBe(5);
  expect(SATURDAY_0300.getDay()).toBe(6);
});

/** A stand-in importer, so no tick in this file can reach the network. */
function fakeImporter(outcome: 'success' | 'failed' = 'success') {
  const calls: string[] = [];
  const runImport = vi.fn(async (_p: PrismaClient, url: string): Promise<UlsImportSummary> => {
    calls.push(url);
    await Promise.resolve();
    return {
      runId: 'run-1',
      generation: 1,
      outcome,
      callsigns: outcome === 'success' ? 823_953 : 0,
      rowsRead: 4_200_000,
      malformedRows: 0,
      removedRows: 0,
      unnamedCallsigns: 0,
      bytesRead: 155_000_000,
      sourceFileDate: 'Sun Aug 30 09:07:53 EDT 2026',
      durationMs: 1000,
      error: outcome === 'failed' ? 'boom' : null,
    };
  });
  return { runImport, calls };
}

/** Record a prior attempt, as runUlsImport would have. */
function recordRun(startedAt: Date, outcome: 'success' | 'failed') {
  return prisma.ulsImportRun.create({
    data: {
      generation: 1,
      startedAt,
      finishedAt: startedAt,
      outcome,
      trigger: 'schedule',
      sourceUrl: CONFIG.url,
    },
  });
}

describe('ulsImportTick — when it runs', () => {
  it('imports on the configured day at the configured hour', async () => {
    const { runImport, calls } = fakeImporter();
    expect(await ulsImportTick(prisma, FRIDAY_0300, CONFIG, { runImport, log: () => {} })).toBe(
      'imported',
    );
    expect(calls).toEqual([CONFIG.url]);
  });

  it('still imports later the same day, so a container down at 03:00 catches up', async () => {
    const { runImport } = fakeImporter();
    expect(await ulsImportTick(prisma, FRIDAY_2300, CONFIG, { runImport, log: () => {} })).toBe(
      'imported',
    );
  });

  it('does nothing on any other day', async () => {
    const { runImport } = fakeImporter();
    for (const day of [THURSDAY_0300, SATURDAY_0300]) {
      expect(await ulsImportTick(prisma, day, CONFIG, { runImport, log: () => {} })).toBe(
        'not-due-day',
      );
    }
    expect(runImport).not.toHaveBeenCalled();
  });

  it('does nothing before the configured hour', async () => {
    const { runImport } = fakeImporter();
    expect(await ulsImportTick(prisma, FRIDAY_0230, CONFIG, { runImport, log: () => {} })).toBe(
      'not-due-hour',
    );
    expect(runImport).not.toHaveBeenCalled();
  });

  it('honours a different configured day and hour', async () => {
    const { runImport } = fakeImporter();
    const sundayConfig = { ...CONFIG, day: 0, hour: 22 };
    const sunday2200 = new Date(2026, 8, 6, 22, 0, 0);
    expect(sunday2200.getDay()).toBe(0);
    expect(
      await ulsImportTick(prisma, sunday2200, sundayConfig, { runImport, log: () => {} }),
    ).toBe('imported');
    // …and the default Friday is then not a run day.
    expect(
      await ulsImportTick(prisma, FRIDAY_0300, sundayConfig, { runImport, log: () => {} }),
    ).toBe('not-due-day');
  });

  it('does nothing when the club has switched the importer off', async () => {
    const { runImport } = fakeImporter();
    expect(
      await ulsImportTick(prisma, FRIDAY_0300, { ...CONFIG, enabled: false }, { runImport }),
    ).toBe('disabled');
    expect(runImport).not.toHaveBeenCalled();
  });
});

describe('ulsImportTick — not re-downloading 155 MB', () => {
  /**
   * The tick fires every 30 minutes, so without this gate a successful 03:00
   * import would be repeated at 03:30, 04:00 and so on for the rest of Friday.
   */
  it('skips when an import already succeeded this week', async () => {
    await recordRun(new Date(FRIDAY_0300.getTime() - 30 * 60_000), 'success');
    const { runImport } = fakeImporter();
    expect(await ulsImportTick(prisma, FRIDAY_0300, CONFIG, { runImport, log: () => {} })).toBe(
      'recent-success',
    );
    expect(runImport).not.toHaveBeenCalled();
  });

  it('runs again once the previous success is older than the interval', async () => {
    await recordRun(new Date(FRIDAY_0300.getTime() - ULS_SUCCESS_INTERVAL_MS - 60_000), 'success');
    const { runImport } = fakeImporter();
    expect(await ulsImportTick(prisma, FRIDAY_0300, CONFIG, { runImport, log: () => {} })).toBe(
      'imported',
    );
  });

  it('still skips a success from six days ago, so a drifting clock cannot double-run', async () => {
    await recordRun(new Date(FRIDAY_0300.getTime() - 5.5 * 24 * 60 * 60 * 1000), 'success');
    const { runImport } = fakeImporter();
    expect(await ulsImportTick(prisma, FRIDAY_0300, CONFIG, { runImport, log: () => {} })).toBe(
      'recent-success',
    );
  });

  /**
   * The crash-loop guard: a container that dies mid-import and restarts must
   * not pull the archive again immediately, and again, and again.
   */
  it('waits out a cooldown after a failed attempt', async () => {
    await recordRun(new Date(FRIDAY_0300.getTime() - 60 * 60_000), 'failed');
    const { runImport } = fakeImporter();
    expect(await ulsImportTick(prisma, FRIDAY_0300, CONFIG, { runImport, log: () => {} })).toBe(
      'retry-cooldown',
    );
    expect(runImport).not.toHaveBeenCalled();
  });

  it('retries later the same day once the cooldown has passed', async () => {
    await recordRun(new Date(FRIDAY_2300.getTime() - ULS_RETRY_COOLDOWN_MS - 60_000), 'failed');
    const { runImport } = fakeImporter();
    expect(await ulsImportTick(prisma, FRIDAY_2300, CONFIG, { runImport, log: () => {} })).toBe(
      'imported',
    );
  });

  it('a run left "running" by a killed process still holds the cooldown', async () => {
    await prisma.ulsImportRun.create({
      data: {
        generation: 1,
        startedAt: new Date(FRIDAY_0300.getTime() - 5 * 60_000),
        outcome: 'running',
        trigger: 'schedule',
        sourceUrl: CONFIG.url,
      },
    });
    const { runImport } = fakeImporter();
    expect(await ulsImportTick(prisma, FRIDAY_0300, CONFIG, { runImport, log: () => {} })).toBe(
      'retry-cooldown',
    );
  });

  it('reports a failed import without throwing', async () => {
    const { runImport } = fakeImporter('failed');
    const messages: string[] = [];
    expect(
      await ulsImportTick(prisma, FRIDAY_0300, CONFIG, {
        runImport,
        log: (m) => messages.push(m),
      }),
    ).toBe('imported');
    expect(messages.join(' ')).toMatch(/FAILED/);
  });
});

describe('startUlsImportScheduler', () => {
  it('returns a stop function that clears the timer', () => {
    const stop = startUlsImportScheduler(prisma, { ...CONFIG, enabled: false });
    expect(typeof stop).toBe('function');
    // Must not throw, and must be safe to call from the SIGTERM path.
    stop();
    stop();
  });

  it('starts no timer at all when disabled', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const stop = startUlsImportScheduler(prisma, { ...CONFIG, enabled: false });
    expect(spy).not.toHaveBeenCalled();
    stop();
    spy.mockRestore();
  });

  // The stand-in importer is not optional here: startUlsImportScheduler fires a
  // catch-up tick immediately, and with the real one that tick would reach the
  // network — but only when the suite happens to run on the configured weekday
  // at or after the configured hour. A test that is green six days a week is
  // worse than no test.
  it('registers a repeating timer when enabled, and stops it', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { runImport } = fakeImporter();
    const stop = startUlsImportScheduler(prisma, { ...CONFIG, enabled: true }, {
      runImport,
      log: () => {},
    });
    expect(spy).toHaveBeenCalledTimes(1);
    stop();
    spy.mockRestore();
  });
});

describe('ulsImportTick: never mid-net', () => {
  /** Minimum rows for a session to exist: a repeater, a net, then a session. */
  async function seedLiveSession(opts: { ended?: boolean }) {
    const repeater = await prisma.repeater.create({
      data: { name: 'W0QQQ', frequency: 145.41, offsetKhz: -600, mode: 'FM' },
    });
    const net = await prisma.net.create({
      data: {
        name: 'Friday Net',
        repeaterId: repeater.id,
        dayOfWeek: 5,
        startLocal: '20:00',
        timezone: 'UTC',
      },
    });
    const at = new Date(2026, 8, 4, 20, 0, 0);
    return prisma.netSession.create({
      data: {
        netId: net.id,
        startedAt: at,
        liveAt: at,
        endedAt: opts.ended ? new Date(2026, 8, 4, 21, 30, 0) : null,
      },
    });
  }

  afterEach(async () => {
    await prisma.netSession.deleteMany();
    await prisma.net.deleteMany();
    await prisma.repeater.deleteMany();
  });

  it('defers while a net is on the air', async () => {
    // 21:00 Friday is exactly where the retry cooldown lands after a failed
    // 03:00 run — the middle of most club nets.
    await seedLiveSession({ ended: false });
    const importer = fakeImporter();
    const outcome = await ulsImportTick(
      prisma,
      new Date(2026, 8, 4, 21, 0, 0),
      CONFIG,
      { runImport: importer.runImport, log: () => {} },
    );
    expect(outcome).toBe('net-live');
    expect(importer.calls).toHaveLength(0);
  });

  it('runs once that net has ended', async () => {
    await seedLiveSession({ ended: true });
    const importer = fakeImporter();
    const outcome = await ulsImportTick(
      prisma,
      new Date(2026, 8, 4, 22, 0, 0),
      CONFIG,
      { runImport: importer.runImport, log: () => {} },
    );
    expect(outcome).toBe('imported');
    expect(importer.calls).toHaveLength(1);
  });
});
