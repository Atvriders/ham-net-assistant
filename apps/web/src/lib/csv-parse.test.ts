import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv-parse.js';

describe('parseCsv', () => {
  it('parses simple CSV', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with embedded commas', () => {
    expect(parseCsv('name,note\n"KS0MAN","Manhattan, KS"')).toEqual([
      ['name', 'note'],
      ['KS0MAN', 'Manhattan, KS'],
    ]);
  });

  it('handles escaped quotes within quoted fields', () => {
    expect(parseCsv('a\n"he said ""hi"""')).toEqual([['a'], ['he said "hi"']]);
  });

  it('skips empty lines', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles \\r\\n line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});
