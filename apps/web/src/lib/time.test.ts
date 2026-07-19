import { describe, it, expect } from 'vitest';
import { formatStartLocal12h, minutesUntilNetStart } from './time.js';

describe('formatStartLocal12h', () => {
  it('formats evening and midnight HH:mm as 12-hour labels', () => {
    expect(formatStartLocal12h('20:00')).toBe('8:00 PM');
    expect(formatStartLocal12h('00:05')).toBe('12:05 AM');
    expect(formatStartLocal12h('12:30')).toBe('12:30 PM');
  });
});

describe('minutesUntilNetStart', () => {
  it('is positive before the start and negative after (UTC)', () => {
    const before = minutesUntilNetStart(
      '20:00',
      'UTC',
      new Date('2026-07-18T19:57:00Z'),
    );
    expect(before).toBeCloseTo(3, 5);
    const after = minutesUntilNetStart(
      '20:00',
      'UTC',
      new Date('2026-07-18T20:10:00Z'),
    );
    expect(after).toBeCloseTo(-10, 5);
  });

  it('counts seconds fractionally', () => {
    const v = minutesUntilNetStart(
      '20:00',
      'UTC',
      new Date('2026-07-18T19:57:30Z'),
    );
    expect(v).toBeCloseTo(2.5, 5);
  });

  it("evaluates the wall clock in the net's timezone, not UTC", () => {
    // 20:00 America/Chicago (CDT, UTC-5) = 01:00Z next day.
    const v = minutesUntilNetStart(
      '20:00',
      'America/Chicago',
      new Date('2026-07-19T00:58:00Z'),
    );
    expect(v).toBeCloseTo(2, 5);
  });

  it('wraps across midnight in both directions', () => {
    // 23:59 → 00:02 start reads as 3 minutes ahead, not -1437.
    expect(
      minutesUntilNetStart('00:02', 'UTC', new Date('2026-07-18T23:59:00Z')),
    ).toBeCloseTo(3, 5);
    // 00:01 → 23:58 start (yesterday's slot) reads as 3 minutes past.
    expect(
      minutesUntilNetStart('23:58', 'UTC', new Date('2026-07-19T00:01:00Z')),
    ).toBeCloseTo(-3, 5);
  });

  it('returns null for malformed startLocal', () => {
    const now = new Date('2026-07-18T19:57:00Z');
    expect(minutesUntilNetStart('', 'UTC', now)).toBeNull();
    expect(minutesUntilNetStart('20h00', 'UTC', now)).toBeNull();
    expect(minutesUntilNetStart('soon', 'UTC', now)).toBeNull();
  });
});
