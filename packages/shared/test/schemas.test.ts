import { describe, it, expect } from 'vitest';
import {
  Callsign, RegisterInput, RepeaterInput, NetInput, CheckInInput,
  ReminderMinutes, parseReminderMinutes, DEFAULT_REMINDER_MINUTES,
} from '../src/index.js';

describe('Callsign', () => {
  it('accepts valid callsigns and uppercases', () => {
    expect(Callsign.parse('kd0xyz')).toBe('KD0XYZ');
  });
  it('rejects too-short', () => {
    expect(() => Callsign.parse('K1')).toThrow();
  });
  it('rejects symbols', () => {
    expect(() => Callsign.parse('W1-ABC')).toThrow();
  });
  it('rejects garbage input', () => {
    expect(() => Callsign.parse('!!@@')).toThrow();
  });
  it('accepts /M mobile suffix', () => {
    expect(Callsign.parse('w1aw/m')).toBe('W1AW/M');
  });
  it('accepts /P portable suffix', () => {
    expect(Callsign.parse('kd0xyz/p')).toBe('KD0XYZ/P');
  });
  it('accepts DL/ prefix', () => {
    expect(Callsign.parse('dl/w1aw')).toBe('DL/W1AW');
  });
  it('accepts /MM maritime mobile suffix', () => {
    expect(Callsign.parse('w1aw/mm')).toBe('W1AW/MM');
  });
  it('accepts /AM aeronautical mobile suffix', () => {
    expect(Callsign.parse('w1aw/am')).toBe('W1AW/AM');
  });
  it('accepts N0CALL placeholder', () => {
    expect(Callsign.parse('n0call')).toBe('N0CALL');
  });
  it('rejects N0CALL with digits (only literal N0CALL allowed)', () => {
    expect(() => Callsign.parse('N0CALL42')).toThrow();
    expect(() => Callsign.parse('N0CALL9999')).toThrow();
  });
});

describe('RegisterInput', () => {
  it('accepts complete input', () => {
    const out = RegisterInput.parse({
      email: 'a@b.co', password: 'longenough', name: 'Alice', callsign: 'W1AW',
    });
    expect(out.callsign).toBe('W1AW');
  });
  it('rejects short password', () => {
    expect(() =>
      RegisterInput.parse({ email: 'a@b.co', password: '1', name: 'A', callsign: 'W1AW' }),
    ).toThrow();
  });
});

describe('RepeaterInput', () => {
  it('accepts valid', () => {
    expect(
      RepeaterInput.parse({ name: 'KSU', frequency: 146.76, offsetKhz: -600, mode: 'FM' }).frequency,
    ).toBe(146.76);
  });
  it('rejects bad mode', () => {
    expect(() =>
      RepeaterInput.parse({ name: 'x', frequency: 1, offsetKhz: 0, mode: 'AM' as never }),
    ).toThrow();
  });
});

describe('NetInput', () => {
  it('accepts HH:mm', () => {
    expect(
      NetInput.parse({
        name: 'Wed Net', repeaterId: 'x', dayOfWeek: 3, startLocal: '20:00',
        timezone: 'America/Chicago',
      }).startLocal,
    ).toBe('20:00');
  });
  it('rejects bad time', () => {
    expect(() =>
      NetInput.parse({
        name: 'x', repeaterId: 'y', dayOfWeek: 3, startLocal: '25:00', timezone: 'UTC',
      }),
    ).toThrow();
  });
  it('accepts an impromptu net without scheduling fields', () => {
    const parsed = NetInput.parse({
      name: 'Pop-up', repeaterId: 'x', kind: 'impromptu',
    });
    expect(parsed.kind).toBe('impromptu');
  });
  it('rejects a weekly net missing scheduling fields', () => {
    expect(() =>
      NetInput.parse({ name: 'x', repeaterId: 'y', kind: 'weekly' }),
    ).toThrow();
  });
  it('accepts each script category', () => {
    for (const category of ['weekly', 'general', 'impromptu'] as const) {
      const parsed = NetInput.parse({
        name: 'Pop-up', repeaterId: 'x', kind: 'impromptu', scriptCategory: category,
      });
      expect(parsed.scriptCategory).toBe(category);
    }
  });
  it('rejects an unknown script category', () => {
    expect(() =>
      NetInput.parse({
        name: 'x', repeaterId: 'y', kind: 'impromptu', scriptCategory: 'monthly' as never,
      }),
    ).toThrow();
  });
});

describe('CheckInInput', () => {
  it('uppercases callsign', () => {
    expect(CheckInInput.parse({ callsign: 'w1aw', nameAtCheckIn: 'Alice' }).callsign).toBe('W1AW');
  });
});

describe('ReminderMinutes', () => {
  it('accepts a normal lead-time array and dedupes + sorts descending', () => {
    expect(ReminderMinutes.parse([30, 240, 30])).toEqual([240, 30]);
  });
  it('accepts an empty array (= no reminders)', () => {
    expect(ReminderMinutes.parse([])).toEqual([]);
  });
  it('rejects zero', () => {
    expect(() => ReminderMinutes.parse([0])).toThrow();
  });
  it('rejects negative values', () => {
    expect(() => ReminderMinutes.parse([-1])).toThrow();
  });
  it('rejects non-integer values', () => {
    expect(() => ReminderMinutes.parse([30.5])).toThrow();
  });
  it('rejects values above one week (10080)', () => {
    expect(() => ReminderMinutes.parse([10081])).toThrow();
  });
  it('rejects more than 10 entries', () => {
    expect(() =>
      ReminderMinutes.parse([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    ).toThrow();
  });
  it('round-trips through NetInput', () => {
    const parsed = NetInput.parse({
      name: 'Wed Net', repeaterId: 'x', dayOfWeek: 3, startLocal: '20:00',
      timezone: 'UTC', reminderMinutes: [60, 1440],
    });
    expect(parsed.reminderMinutes).toEqual([1440, 60]);
  });
});

describe('parseReminderMinutes', () => {
  it('parses a stored JSON-encoded array', () => {
    expect(parseReminderMinutes('[240,30]')).toEqual([240, 30]);
  });
  it('treats null as an empty array', () => {
    expect(parseReminderMinutes(null)).toEqual([]);
  });
  it('treats undefined as an empty array', () => {
    expect(parseReminderMinutes(undefined)).toEqual([]);
  });
  it('treats malformed JSON as an empty array', () => {
    expect(parseReminderMinutes('not json')).toEqual([]);
  });
  it('drops non-array JSON shapes', () => {
    expect(parseReminderMinutes('{"x":1}')).toEqual([]);
  });
  it('matches the legacy 4h+30m default', () => {
    expect([...DEFAULT_REMINDER_MINUTES]).toEqual([240, 30]);
  });
});
