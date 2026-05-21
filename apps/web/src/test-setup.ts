import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom shims for TipTap / ProseMirror, which call DOM geometry APIs that
// jsdom doesn't implement. Without these stubs editor updates raise
// uncaught exceptions during typing in tests.
const emptyRect: DOMRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON() {
    return {};
  },
};

type RangeLike = {
  getClientRects?: () => DOMRect[];
  getBoundingClientRect?: () => DOMRect;
};
const rangeProto = (globalThis as unknown as { Range?: { prototype: RangeLike } })
  .Range?.prototype;
if (rangeProto && typeof rangeProto.getClientRects !== 'function') {
  rangeProto.getClientRects = () => [];
  rangeProto.getBoundingClientRect = () => emptyRect;
}

type ElementLike = { getClientRects?: () => DOMRect[] };
const elementProto = (
  globalThis as unknown as { Element?: { prototype: ElementLike } }
).Element?.prototype;
if (elementProto && typeof elementProto.getClientRects !== 'function') {
  elementProto.getClientRects = () => [];
}

const docRef = (globalThis as unknown as {
  document?: { elementFromPoint?: (x: number, y: number) => Element | null };
}).document;
if (docRef && typeof docRef.elementFromPoint !== 'function') {
  docRef.elementFromPoint = () => null;
}
