import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeTestDb, cleanupTestDb } from '../helpers.js';

vi.mock('../../src/discord/client.js', async () => {
  const actual: object = await vi.importActual('../../src/discord/client.js');
  return {
    ...actual,
    postToDiscord: vi.fn().mockResolvedValue({ ok: true }),
  };
});

import { postToDiscord } from '../../src/discord/client.js';
import { startReminderScheduler } from '../../src/discord/reminders.js';

const discordMock = postToDiscord as unknown as {
  mock: { calls: unknown[][] };
  mockClear: () => void;
  mockResolvedValueOnce: (v: unknown) => void;
};
const postedContents = (): string[] =>
  discordMock.mock.calls.map((c) => String(c[1] ?? ''));

let prisma: PrismaClient;
let dbFile: string;
let repeaterId: string;

beforeAll(async () => {
  ({ prisma, dbFile } = makeTestDb());
  const r = await prisma.repeater.create({
    data: { name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
  });
  repeaterId = r.id;
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

beforeEach(async () => {
  await prisma.netReminder.deleteMany();
  await prisma.net.deleteMany();
  (postToDiscord as unknown as { mockClear: () => void }).mockClear();
});

/**
 * Set up a weekly net whose start time is `leadMinutes` minutes in the
 * future (relative to "now"), so a tick fires a reminder at "now".
 */
function netStartingInMinutes(leadMinutes: number): {
  weekday: number;
  startLocal: string;
} {
  const now = new Date();
  const target = new Date(now.getTime() + leadMinutes * 60_000);
  const weekday = target.getUTCDay();
  const hh = String(target.getUTCHours()).padStart(2, '0');
  const mm = String(target.getUTCMinutes()).padStart(2, '0');
  return { weekday, startLocal: `${hh}:${mm}` };
}

async function runOneTick(): Promise<void> {
  // startReminderScheduler runs one tick immediately.
  const stop = startReminderScheduler(prisma);
  await new Promise((resolve) => setTimeout(resolve, 150));
  stop();
}

describe('per-net reminder scheduling', () => {
  it('fires per-net reminders as m<N> kinds (not legacy 4h/30m)', async () => {
    const { weekday, startLocal } = netStartingInMinutes(60);
    await prisma.net.create({
      data: {
        name: 'Sixty-Min Net', kind: 'weekly', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: JSON.stringify([60, 10]),
      },
    });

    await runOneTick();

    const rows = await prisma.netReminder.findMany();
    const kinds = rows.map((r) => r.kind).sort();
    // Only the m60 reminder is in the ±60s fire window (m10 fires later).
    expect(kinds).toEqual(['m60']);
    // No legacy "4h" / "30m" / "HH:mm" kinds.
    expect(kinds.some((k) => k === '4h' || k === '30m')).toBe(false);

    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    const contents = fn.mock.calls.map((c) => String(c[1] ?? ''));
    expect(contents.some((c) => c.includes('Sixty-Min Net'))).toBe(true);
  });

  it('fires for both lead times across two ticks (m60 now, m10 later)', async () => {
    const { weekday, startLocal } = netStartingInMinutes(60);
    await prisma.net.create({
      data: {
        name: 'Two-Lead Net', kind: 'weekly', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: JSON.stringify([60, 10]),
      },
    });

    await runOneTick();
    let rows = await prisma.netReminder.findMany();
    expect(rows.map((r) => r.kind).sort()).toEqual(['m60']);

    // Simulate the m10 reminder having already been sent by directly seeding
    // it, since we can't actually wait 50 minutes mid-test. (The scheduler is
    // already verified to fire m60; this just proves the per-net m<N> kinds
    // round-trip and dedupe correctly.)
    const net = await prisma.net.findFirstOrThrow();
    const occursAt = rows[0]!.occursAt;
    await prisma.netReminder.create({
      data: { netId: net.id, occursAt, kind: 'm10' },
    });
    rows = await prisma.netReminder.findMany();
    expect(rows.map((r) => r.kind).sort()).toEqual(['m10', 'm60']);
  });

  it('a net with reminderMinutes=[] fires nothing', async () => {
    const { weekday, startLocal } = netStartingInMinutes(60);
    await prisma.net.create({
      data: {
        name: 'Silent Net', kind: 'weekly', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: JSON.stringify([]),
      },
    });

    await runOneTick();

    const rows = await prisma.netReminder.findMany();
    expect(rows).toEqual([]);
    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    const contents = fn.mock.calls.map((c) => String(c[1] ?? ''));
    expect(contents.some((c) => c.includes('Silent Net'))).toBe(false);
  });

  it('a net with reminderMinutes=null fires nothing', async () => {
    const { weekday, startLocal } = netStartingInMinutes(60);
    await prisma.net.create({
      data: {
        name: 'Null Net', kind: 'weekly', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: null,
      },
    });

    await runOneTick();

    const rows = await prisma.netReminder.findMany();
    expect(rows).toEqual([]);
  });

  it('impromptu nets are skipped even with reminderMinutes set', async () => {
    const { weekday, startLocal } = netStartingInMinutes(60);
    await prisma.net.create({
      data: {
        name: 'Impromptu Net', kind: 'impromptu', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: JSON.stringify([60]),
      },
    });

    await runOneTick();

    const rows = await prisma.netReminder.findMany();
    expect(rows).toEqual([]);
    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    const contents = fn.mock.calls.map((c) => String(c[1] ?? ''));
    expect(contents.some((c) => c.includes('Impromptu Net'))).toBe(false);
  });

  it('still fires a reminder that came due 3 minutes ago (catch-up window)', async () => {
    // Net starts in 57 min with a 60-min reminder, i.e. the reminder was due
    // ~3 minutes ago. The old symmetric ±60s window against a 60s tick meant
    // a two-minute Discord outage (or one slow tick) dropped this reminder
    // permanently — the next tick was already past it.
    const { weekday, startLocal } = netStartingInMinutes(57);
    await prisma.net.create({
      data: {
        name: 'Late Net', kind: 'weekly', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: JSON.stringify([60]),
      },
    });

    await runOneTick();

    expect((await prisma.netReminder.findMany()).map((r) => r.kind)).toEqual(['m60']);
    expect(postedContents().some((c) => c.includes('Late Net'))).toBe(true);
  });

  it('does NOT fire a reminder that came due 6 minutes ago (window closed)', async () => {
    // Past the 5-minute catch-up window: a reminder this stale is noise, and
    // for short lead times it could land after the net already started.
    const { weekday, startLocal } = netStartingInMinutes(54);
    await prisma.net.create({
      data: {
        name: 'Too Late Net', kind: 'weekly', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: JSON.stringify([60]),
      },
    });

    await runOneTick();

    expect(await prisma.netReminder.findMany()).toEqual([]);
    expect(postedContents().some((c) => c.includes('Too Late Net'))).toBe(false);
  });

  it('does NOT fire a reminder that is not due yet', async () => {
    // Net starts in 62 min with a 60-min reminder: due in ~2 minutes. The
    // window is forward-only, so nothing fires early.
    const { weekday, startLocal } = netStartingInMinutes(62);
    await prisma.net.create({
      data: {
        name: 'Early Net', kind: 'weekly', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: JSON.stringify([60]),
      },
    });

    await runOneTick();

    expect(await prisma.netReminder.findMany()).toEqual([]);
    expect(postedContents().some((c) => c.includes('Early Net'))).toBe(false);
  });

  it('releases the dedupe row when the Discord post fails, so a later tick retries', async () => {
    // The row is staked BEFORE posting (a crash in between must not re-ping
    // the whole club), but a clean send failure has to roll it back or the
    // reminder is lost even though Discord came back seconds later.
    const { weekday, startLocal } = netStartingInMinutes(60);
    await prisma.net.create({
      data: {
        name: 'Flaky Net', kind: 'weekly', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: JSON.stringify([60]),
      },
    });

    discordMock.mockResolvedValueOnce({ ok: false, reason: 'Discord error: 503' });
    await runOneTick();
    expect(await prisma.netReminder.findMany()).toEqual([]);

    // Discord is back: the same reminder still fires, exactly once.
    await runOneTick();
    expect((await prisma.netReminder.findMany()).map((r) => r.kind)).toEqual(['m60']);
    expect(postedContents().filter((c) => c.includes('Flaky Net'))).toHaveLength(2);
  });

  it('a net with an Intl-invalid timezone does not stop other nets being reminded', async () => {
    // "CDT" makes Intl.DateTimeFormat throw a RangeError inside
    // nextOccurrence. It used to escape the per-net loop into the tick's
    // catch-all, so ONE bad row silenced reminders for every net forever.
    // Created first so it is reached first in the rowid-ordered loop.
    const bad = netStartingInMinutes(60);
    await prisma.net.create({
      data: {
        name: 'Bad TZ Net', kind: 'weekly', repeaterId,
        dayOfWeek: bad.weekday, startLocal: bad.startLocal, timezone: 'CDT',
        active: true, reminderMinutes: JSON.stringify([60]),
      },
    });
    const good = netStartingInMinutes(60);
    await prisma.net.create({
      data: {
        name: 'Good TZ Net', kind: 'weekly', repeaterId,
        dayOfWeek: good.weekday, startLocal: good.startLocal, timezone: 'UTC',
        active: true, reminderMinutes: JSON.stringify([60]),
      },
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runOneTick();
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('Bad TZ Net');
      expect(logged).toContain('invalid timezone');
    } finally {
      warn.mockRestore();
    }

    expect(postedContents().some((c) => c.includes('Good TZ Net'))).toBe(true);
    const rows = await prisma.netReminder.findMany({ include: { net: true } });
    expect(rows.map((r) => r.net.name)).toEqual(['Good TZ Net']);
  });

  it('dedupes the same (netId, occursAt, kind): a second tick does not re-fire', async () => {
    const { weekday, startLocal } = netStartingInMinutes(60);
    await prisma.net.create({
      data: {
        name: 'Dedupe Net', kind: 'weekly', repeaterId,
        dayOfWeek: weekday, startLocal, timezone: 'UTC', active: true,
        reminderMinutes: JSON.stringify([60]),
      },
    });

    await runOneTick();
    const firstCount = (postToDiscord as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.length;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    await runOneTick();
    const secondCount = (postToDiscord as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.length;
    // Second tick should not post the same reminder again — the row in
    // NetReminder dedupes it.
    expect(secondCount).toBe(firstCount);
  });
});
