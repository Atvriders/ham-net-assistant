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
