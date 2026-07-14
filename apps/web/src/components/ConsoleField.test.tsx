import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ConsoleField } from './ConsoleField.js';

/*
 * jsdom has no real canvas. Stub HTMLCanvasElement.prototype.getContext with
 * the minimal 2D surface ConsoleField touches (sizing transform, the sprite
 * gradient, and the draw primitives) so mounting never throws.
 */
function makeCtx2dStub() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  };
}

/** matchMedia stub — `reduced` controls the prefers-reduced-motion query. */
function makeMatchMedia(reduced: boolean) {
  return vi.fn((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() =>
    makeCtx2dStub(),
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal('matchMedia', makeMatchMedia(false));
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ConsoleField', () => {
  it('renders a fixed, aria-hidden, pointer-transparent canvas behind content', () => {
    const { container } = render(<ConsoleField />);
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas!.style.pointerEvents).toBe('none');
    expect(canvas!.style.position).toBe('fixed');
    expect(canvas!.style.zIndex).toBe('-1');
    // resize() pins the CSS box to the buffer's CSS-pixel size (innerWidth/
    // innerHeight) so drawing stays 1:1 with pointer coordinates even when a
    // classic scrollbar makes `100%` resolve narrower than innerWidth.
    expect(canvas!.style.width).toBe(`${window.innerWidth}px`);
    expect(canvas!.style.height).toBe(`${window.innerHeight}px`);
  });

  it('renders nothing at all under prefers-reduced-motion: reduce', () => {
    vi.stubGlobal('matchMedia', makeMatchMedia(true));
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { container } = render(<ConsoleField />);
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.firstChild).toBeNull();
    // No interaction listeners were installed either.
    const types = addSpy.mock.calls.map((c) => c[0]);
    expect(types).not.toContain('pointermove');
    expect(types).not.toContain('pointerdown');
  });

  it('removes every window/document listener it added on unmount', () => {
    const winAdd = vi.spyOn(window, 'addEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const docAdd = vi.spyOn(document, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');

    const { unmount } = render(<ConsoleField />);
    unmount();

    const ours = new Set(['pointermove', 'pointerdown', 'resize', 'visibilitychange']);
    const pairKey = (call: unknown[]) => `${String(call[0])}`;

    for (const [add, remove] of [
      [winAdd, winRemove],
      [docAdd, docRemove],
    ] as const) {
      const added = add.mock.calls.filter((c) => ours.has(String(c[0])));
      for (const call of added) {
        // A removeEventListener with the same type AND the same handler
        // reference must have been issued.
        const matched = remove.mock.calls.some(
          (r) => pairKey(r) === pairKey(call) && r[1] === call[1],
        );
        expect(matched, `unremoved listener: ${String(call[0])}`).toBe(true);
      }
    }
    // Sanity: the component actually registered its interaction listeners.
    const winTypes = winAdd.mock.calls.map((c) => c[0]);
    expect(winTypes).toContain('pointermove');
    expect(winTypes).toContain('pointerdown');
    expect(winTypes).toContain('resize');
    const docTypes = docAdd.mock.calls.map((c) => c[0]);
    expect(docTypes).toContain('visibilitychange');
  });

  it('does not schedule an animation frame while idle (no pointer input)', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    render(<ConsoleField />);
    expect(rafSpy).not.toHaveBeenCalled();
  });
});
