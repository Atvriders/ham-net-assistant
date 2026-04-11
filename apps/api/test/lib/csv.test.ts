import { describe, it, expect } from 'vitest';
import { toCsvRow } from '../../src/lib/csv.js';

describe('toCsvRow', () => {
  it('escapes formula-injection cells with a leading single quote', () => {
    expect(toCsvRow(['=cmd|calc'])).toBe("'=cmd|calc\n");
  });

  it('prefixes cells starting with +, -, @', () => {
    expect(toCsvRow(['+danger'])).toBe("'+danger\n");
    expect(toCsvRow(['-danger'])).toBe("'-danger\n");
    expect(toCsvRow(['@danger'])).toBe("'@danger\n");
  });

  it('leaves normal cells alone', () => {
    expect(toCsvRow(['hello', 'world'])).toBe('hello,world\n');
  });

  it('quotes cells with commas or quotes', () => {
    expect(toCsvRow(['a,b'])).toBe('"a,b"\n');
    expect(toCsvRow(['he said "hi"'])).toBe('"he said ""hi"""\n');
  });
});
