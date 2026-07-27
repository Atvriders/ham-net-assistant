import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// findBy*/waitFor default to 1s. That is enough in a browser but not always in
// jsdom on a shared CI runner: *ByRole queries walk the whole accessibility
// tree, and the net editor renders the full IANA timezone list (~400 options),
// which produced intermittent failures in otherwise-correct tests. A ceiling,
// not a wait — a passing query still resolves on the first tick.
configure({ asyncUtilTimeout: 5000 });

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
