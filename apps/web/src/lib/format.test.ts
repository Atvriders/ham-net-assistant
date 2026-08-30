import { describe, it, expect } from 'vitest';
import {
  capitalizeFirst,
  displayCallsign,
  formatFrequency,
  formatOffset,
  formatTone,
  repeaterDisplayName,
} from './format.js';

describe('displayCallsign', () => {
  it('replaces all zeros with U+00D8', () => {
    expect(displayCallsign('N0CALL')).toBe('NØCALL');
    expect(displayCallsign('W0BPC')).toBe('WØBPC');
    expect(displayCallsign('KD0XYZ')).toBe('KDØXYZ');
    expect(displayCallsign('W1AW')).toBe('W1AW');
  });
  it('handles null/empty', () => {
    expect(displayCallsign(null)).toBe('');
    expect(displayCallsign(undefined)).toBe('');
    expect(displayCallsign('')).toBe('');
  });
  it('preserves other digits', () => {
    expect(displayCallsign('W1A0BC')).toBe('W1AØBC');
  });
});

describe('formatFrequency', () => {
  it('formats MHz to 3 decimals', () => {
    expect(formatFrequency(146.52)).toBe('146.520 MHz');
  });
});

describe('formatOffset', () => {
  it('returns simplex for 0', () => {
    expect(formatOffset(0)).toBe('simplex');
  });
  it('signs positive and negative', () => {
    expect(formatOffset(600)).toBe('+600 kHz');
    expect(formatOffset(-600)).toBe('−600 kHz');
  });
});

describe('formatTone', () => {
  it('handles null/undefined', () => {
    expect(formatTone(null)).toBe('none');
    expect(formatTone(undefined)).toBe('none');
  });
  it('formats hz to 1 decimal', () => {
    expect(formatTone(100)).toBe('100.0 Hz');
  });
});

describe('capitalizeFirst', () => {
  it('capitalizes the first character', () => {
    expect(capitalizeFirst('john')).toBe('John');
  });
  it('leaves an already-uppercase first char alone and preserves the rest', () => {
    expect(capitalizeFirst('JOHN')).toBe('JOHN');
  });
  it('handles empty string', () => {
    expect(capitalizeFirst('')).toBe('');
  });
  it('preserves leading whitespace (caller should trim first)', () => {
    expect(capitalizeFirst(' john')).toBe(' john');
  });
});

describe('repeaterDisplayName', () => {
  it('drops a trailing frequency that repeats the formatted one', () => {
    // The reported bug: the strip read "W0QQQ 145.41 · 145.410 MHz".
    expect(repeaterDisplayName('W0QQQ 145.41', 145.41)).toBe('W0QQQ');
    expect(repeaterDisplayName('W0QQQ 145.410', 145.41)).toBe('W0QQQ');
  });

  it('matches numerically, not textually (145.41 == 145.410 == 145.4100)', () => {
    expect(repeaterDisplayName('W0QQQ 145.4100', 145.41)).toBe('W0QQQ');
    expect(repeaterDisplayName('W0QQQ 145.41', 145.41)).toBe('W0QQQ');
    expect(repeaterDisplayName('W0QQQ 146', 146)).toBe('W0QQQ');
  });

  it('drops a leading frequency', () => {
    expect(repeaterDisplayName('145.41 W0QQQ', 145.41)).toBe('W0QQQ');
  });

  it('handles hyphenated and parenthesised names', () => {
    expect(repeaterDisplayName('W0QQQ-145.41', 145.41)).toBe('W0QQQ');
    expect(repeaterDisplayName('W0QQQ (145.41)', 145.41)).toBe('W0QQQ');
    expect(repeaterDisplayName('W0QQQ [145.410]', 145.41)).toBe('W0QQQ');
  });

  it('trims separator debris left behind by the removal', () => {
    expect(repeaterDisplayName('W0QQQ - 145.41', 145.41)).toBe('W0QQQ');
    expect(repeaterDisplayName('W0QQQ · 145.410', 145.41)).toBe('W0QQQ');
    expect(repeaterDisplayName('W0QQQ - 145.41 - North', 145.41)).toBe('W0QQQ - North');
    expect(repeaterDisplayName('Hilltop 145.410 Machine', 145.41)).toBe('Hilltop Machine');
  });

  it('swallows a unit the club typed after the number', () => {
    expect(repeaterDisplayName('W0QQQ 145.410 MHz', 145.41)).toBe('W0QQQ');
    expect(repeaterDisplayName('W0QQQ 145.41MHz', 145.41)).toBe('W0QQQ');
  });

  it('leaves a NON-matching number completely alone', () => {
    // A name listing a different machine must never be silently mangled.
    expect(repeaterDisplayName('Mt Oread 146.94', 145.41)).toBe('Mt Oread 146.94');
    expect(repeaterDisplayName('W0QQQ 145.42', 145.41)).toBe('W0QQQ 145.42');
    expect(repeaterDisplayName('K0ABC 2m', 145.41)).toBe('K0ABC 2m');
    expect(repeaterDisplayName('Repeater 1', 145.41)).toBe('Repeater 1');
  });

  it('never strips digits welded into a callsign', () => {
    expect(repeaterDisplayName('W0QQQ', 0)).toBe('W0QQQ');
    expect(repeaterDisplayName('K0RC 145.41', 145.41)).toBe('K0RC');
  });

  it('returns the ORIGINAL name rather than an unlabelled row', () => {
    // Stripping everything would leave the operator with a blank name cell.
    expect(repeaterDisplayName('145.410', 145.41)).toBe('145.410');
    expect(repeaterDisplayName('  145.41  ', 145.41)).toBe('  145.41  ');
    expect(repeaterDisplayName('(145.410 MHz)', 145.41)).toBe('(145.410 MHz)');
  });

  it('passes through empty names and non-finite frequencies', () => {
    expect(repeaterDisplayName('', 145.41)).toBe('');
    expect(repeaterDisplayName('W0QQQ 145.41', Number.NaN)).toBe('W0QQQ 145.41');
  });
});
