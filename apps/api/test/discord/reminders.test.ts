import { describe, it, expect } from 'vitest';
import {
  nextOccurrence,
  wallClockIn,
  instantFromWallClock,
} from '../../src/discord/reminders.js';

describe('wallClockIn', () => {
  it('returns the wall-clock components for a UTC instant in America/Chicago (CDT)', () => {
    // 2026-04-26T01:00:00Z is 2026-04-25 20:00 CDT
    const w = wallClockIn('America/Chicago', new Date('2026-04-26T01:00:00Z'));
    expect(w.year).toBe(2026);
    expect(w.month).toBe(4);
    expect(w.day).toBe(25);
    expect(w.hour).toBe(20);
    expect(w.minute).toBe(0);
    expect(w.weekday).toBe(6); // Saturday
  });

  it('returns the wall-clock components for a UTC instant in America/Chicago (CST)', () => {
    // 2026-03-08T02:00:00Z is 2026-03-07 20:00 CST (DST not yet active)
    const w = wallClockIn('America/Chicago', new Date('2026-03-08T02:00:00Z'));
    expect(w.year).toBe(2026);
    expect(w.month).toBe(3);
    expect(w.day).toBe(7);
    expect(w.hour).toBe(20);
    expect(w.weekday).toBe(6); // Saturday
  });
});

describe('instantFromWallClock', () => {
  it('resolves a Chicago wall-clock during CDT to the right UTC instant', () => {
    // April 25, 2026 20:00 CDT (UTC-5) === April 26, 2026 01:00 UTC
    const utc = instantFromWallClock('America/Chicago', 2026, 4, 25, 20, 0);
    expect(utc.toISOString()).toBe('2026-04-26T01:00:00.000Z');
  });

  it('resolves a Chicago wall-clock during CST to the right UTC instant', () => {
    // March 7, 2026 20:00 CST (UTC-6) === March 8, 2026 02:00 UTC
    const utc = instantFromWallClock('America/Chicago', 2026, 3, 7, 20, 0);
    expect(utc.toISOString()).toBe('2026-03-08T02:00:00.000Z');
  });

  it('handles UTC tz identically', () => {
    const utc = instantFromWallClock('UTC', 2026, 4, 29, 20, 0);
    expect(utc.toISOString()).toBe('2026-04-29T20:00:00.000Z');
  });
});

describe('nextOccurrence (timezone-aware)', () => {
  it('returns same-day Saturday 20:00 Central when called Saturday 14:00 Central (CDT)', () => {
    // 2026-04-25 14:00 CDT === 2026-04-25T19:00:00Z
    const now = new Date('2026-04-25T19:00:00Z').getTime();
    const got = nextOccurrence(6, '20:00', 'America/Chicago', now);
    // Sat Apr 25 20:00 CDT === Sun Apr 26 01:00 UTC
    expect(got.toISOString()).toBe('2026-04-26T01:00:00.000Z');
  });

  it('rolls to next Saturday when called Saturday 21:00 Central (already past)', () => {
    // 2026-04-25 21:00 CDT === 2026-04-26T02:00:00Z
    const now = new Date('2026-04-26T02:00:00Z').getTime();
    const got = nextOccurrence(6, '20:00', 'America/Chicago', now);
    // Next Sat is May 2; 20:00 CDT === May 3 01:00 UTC
    expect(got.toISOString()).toBe('2026-05-03T01:00:00.000Z');
  });

  it('finds next matching weekday across week boundaries (Wed -> Sat in Chicago)', () => {
    // 2026-04-29 12:00 CDT === 2026-04-29T17:00:00Z (Wednesday)
    const now = new Date('2026-04-29T17:00:00Z').getTime();
    const got = nextOccurrence(6, '09:00', 'America/Chicago', now);
    // Saturday May 2 09:00 CDT === May 2 14:00 UTC
    expect(got.toISOString()).toBe('2026-05-02T14:00:00.000Z');
  });

  it('parses HH:mm with leading-zero minutes', () => {
    const now = new Date('2026-04-29T17:00:00Z').getTime();
    const got = nextOccurrence(3, '20:05', 'America/Chicago', now);
    // Wed Apr 29 20:05 CDT === Apr 30 01:05 UTC
    expect(got.toISOString()).toBe('2026-04-30T01:05:00.000Z');
  });

  it('exactly-now rolls forward by a week (uses <= comparison)', () => {
    // Wednesday at 20:00 CDT exactly === 2026-04-30T01:00:00Z
    const now = new Date('2026-04-30T01:00:00Z').getTime();
    const got = nextOccurrence(3, '20:00', 'America/Chicago', now);
    // Should roll to next Wednesday May 6 20:00 CDT === May 7 01:00 UTC
    expect(got.toISOString()).toBe('2026-05-07T01:00:00.000Z');
  });

  it('handles UTC timezone (server-local fallback)', () => {
    // Wed Apr 29 12:00 UTC, net is Wed at 20:00 UTC
    const now = new Date('2026-04-29T12:00:00Z').getTime();
    const got = nextOccurrence(3, '20:00', 'UTC', now);
    expect(got.toISOString()).toBe('2026-04-29T20:00:00.000Z');
  });

  it('reminder 16:00 Central is exactly 4 hours before 20:00 Central net (CDT)', () => {
    // Net occurrence: Sat Apr 25 20:00 CDT === Apr 26 01:00 UTC
    // Reminder: Sat Apr 25 16:00 CDT === Apr 25 21:00 UTC
    const now = new Date('2026-04-25T19:00:00Z').getTime();
    const occurs = nextOccurrence(6, '20:00', 'America/Chicago', now);
    const wall = wallClockIn('America/Chicago', occurs);
    const reminderAt = instantFromWallClock(
      'America/Chicago',
      wall.year, wall.month, wall.day, 16, 0,
    );
    expect(reminderAt.toISOString()).toBe('2026-04-25T21:00:00.000Z');
    // Confirms the 4-hour delta
    expect(occurs.getTime() - reminderAt.getTime()).toBe(4 * 60 * 60 * 1000);
  });

  it('handles spring-forward DST transition correctly', () => {
    // DST starts in Chicago on Sunday March 8, 2026 (02:00 -> 03:00 local).
    // For a Saturday net at 20:00 Central on March 7 (CST, UTC-6):
    // Wall 2026-03-07 20:00 CST === 2026-03-08 02:00 UTC.
    // Called from Saturday Mar 7 14:00 CST === Mar 7 20:00 UTC.
    const now = new Date('2026-03-07T20:00:00Z').getTime();
    const got = nextOccurrence(6, '20:00', 'America/Chicago', now);
    expect(got.toISOString()).toBe('2026-03-08T02:00:00.000Z');

    // The 16:00 CST reminder on that day === Mar 7 22:00 UTC
    const wall = wallClockIn('America/Chicago', got);
    const reminderAt = instantFromWallClock(
      'America/Chicago', wall.year, wall.month, wall.day, 16, 0,
    );
    expect(reminderAt.toISOString()).toBe('2026-03-07T22:00:00.000Z');
    // Still 4 hours apart even though DST transition is the next day.
    expect(got.getTime() - reminderAt.getTime()).toBe(4 * 60 * 60 * 1000);
  });

  it('after spring-forward, the following week resolves under CDT', () => {
    // Next Saturday after the spring-forward weekend: March 14, 2026.
    // Called from Sun Mar 8 12:00 CDT === Mar 8 17:00 UTC.
    const now = new Date('2026-03-08T17:00:00Z').getTime();
    const got = nextOccurrence(6, '20:00', 'America/Chicago', now);
    // Sat Mar 14 20:00 CDT (UTC-5) === Mar 15 01:00 UTC
    expect(got.toISOString()).toBe('2026-03-15T01:00:00.000Z');
  });
});
