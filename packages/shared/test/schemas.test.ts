import { describe, it, expect } from 'vitest';
import {
  Callsign, RegisterInput, RepeaterInput, NetInput, NetUpdate, CheckInInput,
  ReminderMinutes, parseReminderMinutes, DEFAULT_REMINDER_MINUTES,
  NetScript, NetScriptInput, isValidTimezone,
  Role, ROLE_RANK, ROLE_LABEL, roleAtLeast,
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
      email: 'a@b.co', password: 'longenoughnow', name: 'Alice', callsign: 'W1AW',
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

// A timezone Intl can't parse makes every scheduler throw a RangeError, which
// used to take down auto-open, auto-start AND reminders for EVERY net. The
// API boundary is where that has to be caught.
describe('NetInput timezone validation', () => {
  const weekly = { name: 'Wed Net', repeaterId: 'x', dayOfWeek: 3, startLocal: '20:00' };

  it.each(['America/Chicago', 'UTC', 'Europe/London', 'Pacific/Honolulu'])(
    'accepts the IANA zone %s',
    (timezone) => {
      expect(NetInput.parse({ ...weekly, timezone }).timezone).toBe(timezone);
    },
  );

  it('accepts the legacy fixed-offset zones Intl still knows (EST, MST)', () => {
    // Not a recommendation — "EST" is UTC-5 year-round, so a club that types
    // it will drift an hour every summer. But Intl accepts it, the schedulers
    // therefore handle it without throwing, and the schema's job is only to
    // keep zones Intl REJECTS out of the database.
    expect(NetInput.parse({ ...weekly, timezone: 'EST' }).timezone).toBe('EST');
  });

  it.each([
    ['CDT', 'a US timezone abbreviation'],
    ['PDT', 'a daylight-time abbreviation'],
    ['Eastern', 'a friendly name'],
    ['UTC-6', 'a raw offset'],
    [' America/Chicago ', 'a pasted value with surrounding whitespace'],
    ['America/Chicago ', 'a trailing space'],
    ['Not/AZone', 'a plausible-looking but unknown zone'],
    ['', 'empty'],
  ])('rejects %s (%s)', (timezone) => {
    expect(() => NetInput.parse({ ...weekly, timezone })).toThrow();
  });

  it('reports the failure on the timezone field with an actionable message', () => {
    const res = NetInput.safeParse({ ...weekly, timezone: 'CDT' });
    expect(res.success).toBe(false);
    const issue = res.error!.issues.find((i) => i.path[0] === 'timezone');
    expect(issue).toBeDefined();
    expect(issue!.message).toBe('Must be an IANA timezone like America/Chicago');
  });

  it('PATCH bodies are validated too (NetUpdate shares the field)', () => {
    expect(() => NetUpdate.parse({ timezone: 'Eastern' })).toThrow();
    expect(NetUpdate.parse({ timezone: 'America/Denver' }).timezone).toBe('America/Denver');
  });

  it('an impromptu net may still omit the timezone entirely', () => {
    expect(NetInput.parse({ name: 'Pop-up', repeaterId: 'x', kind: 'impromptu' }).timezone)
      .toBeUndefined();
  });
});

describe('isValidTimezone', () => {
  it('mirrors what Intl.DateTimeFormat will accept', () => {
    for (const tz of ['America/Chicago', 'UTC', 'Asia/Tokyo']) {
      expect(isValidTimezone(tz)).toBe(true);
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
    }
    for (const tz of ['CDT', 'Eastern', 'UTC-6', ' America/Chicago ']) {
      expect(isValidTimezone(tz)).toBe(false);
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).toThrow();
    }
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

describe('NetScriptInput', () => {
  it('accepts a minimal valid payload', () => {
    const out = NetScriptInput.parse({ title: 'Hello', body: 'a body' });
    expect(out.title).toBe('Hello');
    expect(out.body).toBe('a body');
    expect(out.category).toBeUndefined();
  });
  it('trims and accepts a 1-char title', () => {
    expect(NetScriptInput.parse({ title: '  x  ', body: '' }).title).toBe('x');
  });
  it('rejects an empty title', () => {
    expect(() => NetScriptInput.parse({ title: '', body: '' })).toThrow();
  });
  it('rejects whitespace-only title (post-trim is empty)', () => {
    expect(() => NetScriptInput.parse({ title: '   ', body: '' })).toThrow();
  });
  it('rejects a title over 200 chars', () => {
    expect(() =>
      NetScriptInput.parse({ title: 'x'.repeat(201), body: '' }),
    ).toThrow();
  });
  it('rejects a body over 20000 chars', () => {
    expect(() =>
      NetScriptInput.parse({ title: 'ok', body: 'x'.repeat(20001) }),
    ).toThrow();
  });
  it('accepts all valid categories', () => {
    expect(
      NetScriptInput.parse({ title: 'a', body: '', category: 'weekly' }).category,
    ).toBe('weekly');
    expect(
      NetScriptInput.parse({ title: 'a', body: '', category: 'impromptu' })
        .category,
    ).toBe('impromptu');
    expect(
      NetScriptInput.parse({ title: 'a', body: '', category: 'general' }).category,
    ).toBe('general');
  });
  it('rejects an unknown category', () => {
    expect(() =>
      NetScriptInput.parse({ title: 'a', body: '', category: 'mystery' }),
    ).toThrow();
  });
});

describe('NetScript', () => {
  it('round-trips a fully-populated row', () => {
    const row = {
      id: 'cuid1',
      title: 'Opening',
      category: 'weekly' as const,
      body: '# hi',
      createdById: 'u1',
      createdByCallsign: 'W1AW',
      createdByName: 'Alice',
      createdAt: '2026-05-21T12:00:00.000Z',
      updatedAt: '2026-05-21T12:00:00.000Z',
    };
    const parsed = NetScript.parse(row);
    expect(parsed).toEqual(row);
  });
  it('accepts a null author (createdBy SetNull)', () => {
    const parsed = NetScript.parse({
      id: 'x',
      title: 't',
      category: 'general',
      body: '',
      createdById: null,
      createdAt: '2026-05-21T12:00:00.000Z',
      updatedAt: '2026-05-21T12:00:00.000Z',
    });
    expect(parsed.createdById).toBeNull();
  });
});

describe('Role rank + NET_CONTROL', () => {
  it('Role enum includes NET_CONTROL alongside the legacy roles', () => {
    expect(Role.options).toEqual(['MEMBER', 'NET_CONTROL', 'OFFICER', 'ADMIN']);
    expect(Role.parse('NET_CONTROL')).toBe('NET_CONTROL');
  });

  it('ranks MEMBER < NET_CONTROL < OFFICER < ADMIN', () => {
    expect(ROLE_RANK.MEMBER).toBe(0);
    expect(ROLE_RANK.NET_CONTROL).toBe(1);
    expect(ROLE_RANK.OFFICER).toBe(2);
    expect(ROLE_RANK.ADMIN).toBe(3);
    expect(ROLE_RANK.MEMBER)
      .toBeLessThan(ROLE_RANK.NET_CONTROL);
    expect(ROLE_RANK.NET_CONTROL)
      .toBeLessThan(ROLE_RANK.OFFICER);
    expect(ROLE_RANK.OFFICER)
      .toBeLessThan(ROLE_RANK.ADMIN);
  });

  it('roleAtLeast: NET_CONTROL clears NET_CONTROL/MEMBER but not OFFICER/ADMIN', () => {
    expect(roleAtLeast('NET_CONTROL', 'NET_CONTROL')).toBe(true);
    expect(roleAtLeast('NET_CONTROL', 'MEMBER')).toBe(true);
    expect(roleAtLeast('NET_CONTROL', 'OFFICER')).toBe(false);
    expect(roleAtLeast('NET_CONTROL', 'ADMIN')).toBe(false);
  });

  it('roleAtLeast: MEMBER fails the NET_CONTROL bar (no-access guarantee)', () => {
    expect(roleAtLeast('MEMBER', 'NET_CONTROL')).toBe(false);
    expect(roleAtLeast('MEMBER', 'MEMBER')).toBe(true);
  });

  it('roleAtLeast: OFFICER and ADMIN outrank NET_CONTROL', () => {
    expect(roleAtLeast('OFFICER', 'NET_CONTROL')).toBe(true);
    expect(roleAtLeast('ADMIN', 'NET_CONTROL')).toBe(true);
  });

  it('exposes a human-readable "Net Control" label', () => {
    expect(ROLE_LABEL.NET_CONTROL).toBe('Net Control');
    expect(ROLE_LABEL.OFFICER).toBe('Officer');
  });
});
