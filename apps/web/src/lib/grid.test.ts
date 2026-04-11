import { describe, it, expect } from 'vitest';
import { decodeGrid } from './grid.js';

describe('decodeGrid', () => {
  it('decodes 4-char EM38 to center of square', () => {
    const r = decodeGrid('EM38');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(38.5, 1);
    expect(r!.lon).toBeCloseTo(-93, 1);
  });

  it('decodes 6-char FN20xr to NYC area', () => {
    const r = decodeGrid('FN20xr');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(40.7, 1);
    expect(r!.lon).toBeCloseTo(-74.0, 1);
  });

  it('returns null for invalid input', () => {
    expect(decodeGrid('INVALID')).toBeNull();
    expect(decodeGrid('ZZ99')).toBeNull();
    expect(decodeGrid('')).toBeNull();
  });

  it('decodes 6-char EM38ww', () => {
    const r = decodeGrid('EM38ww');
    expect(r).not.toBeNull();
    // should be near top-right corner of EM38 square (center is 38.5,-93)
    expect(r!.lat).toBeGreaterThan(38.5);
    expect(r!.lon).toBeGreaterThan(-94);
    expect(r!.lon).toBeLessThan(-92);
  });
});
