import { describe, it, expect } from 'vitest';
import { displayCallsign, formatFrequency, formatOffset, formatTone } from './format.js';

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
