import { describe, it, expect } from 'vitest';
import { moveItem } from './reorder.js';

const base = ['a', 'b', 'c', 'd'];

describe('moveItem', () => {
  it('moves an item earlier', () => {
    expect(moveItem(base, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves an item later', () => {
    expect(moveItem(base, 1, 2)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves the last item to the front — the "missed one" case', () => {
    // The station heard first but logged last: this is the whole feature.
    expect(moveItem(base, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('is a no-op at the edges', () => {
    expect(moveItem(base, 0, -1)).toEqual(base);
    expect(moveItem(base, 3, 4)).toEqual(base);
  });

  it('never mutates the input', () => {
    const input = [...base];
    moveItem(input, 0, 3);
    expect(input).toEqual(base);
  });

  it('preserves length and membership', () => {
    const out = moveItem(base, 3, 1);
    expect(out).toHaveLength(base.length);
    expect([...out].sort()).toEqual([...base].sort());
  });
});
