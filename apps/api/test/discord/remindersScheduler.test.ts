import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { setSetting } from '../../src/lib/settings.js';

let prisma: PrismaClient;
let dbFile: string;

beforeAll(async () => {
  ({ prisma, dbFile } = makeTestDb());
});
afterAll(async () => { await cleanupTestDb(prisma, dbFile); });

describe('reminder scheduler excludes impromptu nets', () => {
  it('fires a reminder for a weekly net but never for an impromptu net', async () => {
    const repeater = await prisma.repeater.create({
      data: { name: 'R1', frequency: 146.76, offsetKhz: -600, mode: 'FM' },
    });

    // Anchor the reminder/net schedule to "now" so a tick fires within the window.
    const now = new Date();
    const tz = 'UTC';
    const weekday = now.getUTCDay();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const reminderTime = `${hh}:${mm}`;
    // Net start is 1 hour later so the "now" reminder is before the net start.
    const startHh = String((now.getUTCHours() + 1) % 24).padStart(2, '0');
    const netStart = `${startHh}:${mm}`;

    await setSetting(prisma, 'discord.reminderTimesOfDay', JSON.stringify([reminderTime]));

    await prisma.net.create({
      data: {
        name: 'Weekly Net', kind: 'weekly', repeaterId: repeater.id,
        dayOfWeek: weekday, startLocal: netStart, timezone: tz, active: true,
      },
    });
    await prisma.net.create({
      data: {
        name: 'Impromptu Net', kind: 'impromptu', repeaterId: repeater.id,
        dayOfWeek: weekday, startLocal: netStart, timezone: tz, active: true,
      },
    });

    (postToDiscord as unknown as { mockClear: () => void }).mockClear();
    // startReminderScheduler runs one tick immediately.
    const stop = startReminderScheduler(prisma);
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop();

    const fn = postToDiscord as unknown as { mock: { calls: unknown[][] } };
    const contents = fn.mock.calls.map((c) => String(c[1] ?? ''));
    expect(contents.some((c) => c.includes('Weekly Net'))).toBe(true);
    expect(contents.some((c) => c.includes('Impromptu Net'))).toBe(false);
  });
});
