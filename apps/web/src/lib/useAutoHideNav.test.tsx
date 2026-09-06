/**
 * Auto-hide nav. jsdom has no scrolling and no layout, so the behaviour is
 * driven the way the hook actually reads it — window.scrollY plus a scroll
 * event — and asserted on the `data-nav-hidden` attribute the CSS keys off.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useAutoHideNav } from './useAutoHideNav.js';

function stubNarrow(narrow: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: narrow && q.includes('1023'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia,
  );
}

/** rAF in jsdom is async; run the callback immediately so scrolls settle. */
function stubRaf() {
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  }) as unknown as typeof requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', (() => {}) as unknown as typeof cancelAnimationFrame);
}

function scrollTo(y: number) {
  act(() => {
    Object.defineProperty(window, 'scrollY', { value: y, writable: true, configurable: true });
    window.dispatchEvent(new Event('scroll'));
  });
}

function Harness() {
  useAutoHideNav();
  return (
    <header className="hna-shell__nav">
      <a href="/nets">Nets</a>
    </header>
  );
}

const hidden = () => document.documentElement.dataset.navHidden;

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.navHidden;
  // window.scrollY persists across tests in a shared jsdom document, and the
  // hook seeds `lastY` from it at mount — a test starting at someone else's
  // scroll position measures a delta nobody intended.
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
});

describe('useAutoHideNav', () => {
  it('hides while reading down and returns on the first scroll back up', () => {
    stubNarrow(true);
    stubRaf();
    render(<Harness />);
    expect(hidden()).toBeUndefined();

    scrollTo(400);
    expect(hidden()).toBe('true');

    scrollTo(340);
    expect(hidden()).toBeUndefined();
  });

  it('always shows the nav near the top of the page', () => {
    stubNarrow(true);
    stubRaf();
    render(<Harness />);
    scrollTo(400);
    expect(hidden()).toBe('true');
    // Back within the arming distance — this is where someone looking for the
    // menu goes, so it must be there.
    scrollTo(20);
    expect(hidden()).toBeUndefined();
  });

  it('ignores thumb jitter', () => {
    stubNarrow(true);
    stubRaf();
    render(<Harness />);
    scrollTo(400);
    expect(hidden()).toBe('true');
    scrollTo(397); // 3px — below the deadband
    expect(hidden()).toBe('true');
  });

  it('reveals the nav when keyboard focus enters it', async () => {
    stubNarrow(true);
    stubRaf();
    const { getByRole } = render(<Harness />);
    scrollTo(400);
    expect(hidden()).toBe('true');

    act(() => {
      getByRole('link', { name: 'Nets' }).focus();
    });
    // A hidden bar containing focusable links would otherwise be a tab trap.
    await waitFor(() => expect(hidden()).toBeUndefined());
  });

  it('never engages on a desktop viewport', () => {
    stubNarrow(false);
    stubRaf();
    render(<Harness />);
    scrollTo(800);
    expect(hidden()).toBeUndefined();
  });

  it('clears the attribute on unmount so other pages are unaffected', () => {
    stubNarrow(true);
    stubRaf();
    const { unmount } = render(<Harness />);
    scrollTo(400);
    expect(hidden()).toBe('true');
    unmount();
    expect(hidden()).toBeUndefined();
  });
});
