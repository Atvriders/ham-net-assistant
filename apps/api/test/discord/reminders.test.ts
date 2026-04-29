import { describe, it, expect } from 'vitest';
import { nextOccurrence } from '../../src/discord/reminders.js';

describe('nextOccurrence', () => {
  it('returns same-day occurrence when start is later today', () => {
    // Wednesday Apr 29 2026 12:00 local
    const now = new Date(2026, 3, 29, 12, 0, 0).getTime();
    // Wednesday at 20:00
    const got = nextOccurrence(3, '20:00', now);
    expect(got.getDay()).toBe(3);
    expect(got.getHours()).toBe(20);
    expect(got.getMinutes()).toBe(0);
    // Same calendar day
    expect(got.getDate()).toBe(29);
  });

  it('rolls to next week when start has already passed today', () => {
    // Wednesday at 21:00 local
    const now = new Date(2026, 3, 29, 21, 0, 0).getTime();
    // Net is Wednesday at 20:00 — already passed
    const got = nextOccurrence(3, '20:00', now);
    expect(got.getDay()).toBe(3);
    expect(got.getHours()).toBe(20);
    // Next Wednesday is Apr 29 + 7 = May 6
    expect(got.getMonth()).toBe(4); // May
    expect(got.getDate()).toBe(6);
  });

  it('finds the next matching weekday across week boundaries', () => {
    // Wednesday Apr 29 2026 12:00 local
    const now = new Date(2026, 3, 29, 12, 0, 0).getTime();
    // Net is Saturday (6) at 09:00
    const got = nextOccurrence(6, '09:00', now);
    expect(got.getDay()).toBe(6);
    expect(got.getHours()).toBe(9);
    expect(got.getMinutes()).toBe(0);
    // 3 days after Wednesday = Saturday May 2
    expect(got.getMonth()).toBe(4);
    expect(got.getDate()).toBe(2);
  });

  it('parses HH:mm with leading-zero minutes', () => {
    const now = new Date(2026, 3, 29, 12, 0, 0).getTime();
    const got = nextOccurrence(3, '20:05', now);
    expect(got.getHours()).toBe(20);
    expect(got.getMinutes()).toBe(5);
  });

  it('exactly-now rolls forward by a week (uses <= comparison)', () => {
    // Wednesday at 20:00 local exactly
    const now = new Date(2026, 3, 29, 20, 0, 0).getTime();
    const got = nextOccurrence(3, '20:00', now);
    // Should be next Wednesday
    expect(got.getDate()).toBe(29 + 7 - 30); // May 6, since April has 30 days
    expect(got.getMonth()).toBe(4);
  });
});
