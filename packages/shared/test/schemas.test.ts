import { describe, it, expect } from 'vitest';
import {
  Callsign, RegisterInput, RepeaterInput, NetInput, CheckInInput,
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
  it('accepts N0CALL with digits', () => {
    expect(Callsign.parse('N0CALL42')).toBe('N0CALL42');
    expect(Callsign.parse('N0CALL9999')).toBe('N0CALL9999');
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
});

describe('CheckInInput', () => {
  it('uppercases callsign', () => {
    expect(CheckInInput.parse({ callsign: 'w1aw', nameAtCheckIn: 'Alice' }).callsign).toBe('W1AW');
  });
});
