import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ConsoleField } from './ConsoleField.js';

/*
 * jsdom has no real canvas. Stub HTMLCanvasElement.prototype.getContext with
 * the minimal 2D surface ConsoleField touches (sizing transform, the sprite's
 * radial gradient, the crosshair's linear gradients, and the draw primitives)
 * so mounting and animating never throw.
 */
function makeCtx2dStub() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
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

/** jsdom lacks a PointerEvent constructor; MouseEvent carries the only fields
 *  ConsoleField reads (clientX/clientY) and dispatches under a pointer type. */
function pointerEvent(type: string, x = 120, y = 96) {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
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
  });

  it('pins the canvas CSS box to the buffer size in px (classic-scrollbar fix)', () => {
    const { container } = render(<ConsoleField />);
    const canvas = container.querySelector('canvas')!;
    // resize() pins the CSS box to the buffer's CSS-pixel size (innerWidth/
    // innerHeight) so drawing stays 1:1 with pointer coordinates even when a
    // classic scrollbar makes `100%` resolve narrower than innerWidth.
    expect(canvas.style.width).toBe(`${window.innerWidth}px`);
    expect(canvas.style.height).toBe(`${window.innerHeight}px`);
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
    expect(types).not.toContain('blur');
  });

  it('removes every window/document listener it added on unmount', () => {
    const winAdd = vi.spyOn(window, 'addEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const docAdd = vi.spyOn(document, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');

    const { unmount } = render(<ConsoleField />);
    unmount();

    const ours = new Set([
      'pointermove',
      'pointerleave',
      'mouseleave',
      'blur',
      'resize',
      'visibilitychange',
    ]);
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
    // Sanity: the component actually registered its interaction listeners —
    // and, since the click animation was removed, no pointerdown listener.
    const winTypes = winAdd.mock.calls.map((c) => c[0]);
    expect(winTypes).toContain('pointermove');
    expect(winTypes).toContain('blur');
    expect(winTypes).toContain('resize');
    expect(winTypes).not.toContain('pointerdown');
    const docTypes = docAdd.mock.calls.map((c) => c[0]);
    expect(docTypes).toContain('pointerleave');
    expect(docTypes).toContain('mouseleave');
    expect(docTypes).toContain('visibilitychange');
    expect(docTypes).not.toContain('pointerdown');
  });

  it('does not schedule an animation frame while idle (no pointer input)', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    render(<ConsoleField />);
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('starts the animation loop on pointermove', () => {
    render(<ConsoleField />);
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    window.dispatchEvent(pointerEvent('pointermove'));
    expect(rafSpy).toHaveBeenCalled();
  });

  it('ignores clicks entirely — a pointerdown schedules no animation frame', () => {
    render(<ConsoleField />);
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    window.dispatchEvent(pointerEvent('pointerdown'));
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('shuts the loop down once a stationary cursor saturates (no perpetual 60fps loop)', () => {
    // Drive rAF by hand so we can pump frames and watch the loop shut itself
    // down. This is the idle-loop guarantee: the dwell bloom charges, holds,
    // and then costs nothing — the last frame stays painted on the canvas.
    let queued: FrameRequestCallback | null = null;
    let nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued = cb;
      return nextId++;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      queued = null;
    });

    render(<ConsoleField />);
    // A single pointer move; the cursor then never moves again.
    window.dispatchEvent(pointerEvent('pointermove', 120, 96));

    let now = 0;
    let frames = 0;
    while (queued !== null && frames < 600) {
      const cb: FrameRequestCallback = queued;
      queued = null;
      now += 16;
      cb(now);
      frames++;
    }

    // Every integrator has run out: the trail cooled (800ms), the presence
    // envelope saturated (160ms) and the dwell bloom fully charged (800ms) —
    // so no further frame was scheduled, well under the 600-frame (~9.6s) cap.
    expect(queued).toBeNull();
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThan(200);
  });
});
