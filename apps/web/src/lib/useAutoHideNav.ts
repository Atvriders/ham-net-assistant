import React from 'react';
import { useMediaQuery } from './useMediaQuery.js';

/** Below this width the nav wraps to 150-230px — a third of a phone screen. */
const NARROW = '(max-width: 1023px)';
/** Don't start hiding until the nav would already be scrolled against. */
const ARM_AFTER_PX = 72;
/** Ignore sub-pixel and thumb-jitter deltas, which would flicker the bar. */
const MIN_DELTA_PX = 6;

/**
 * Auto-hide the app-shell nav while reading down a long page on a phone.
 *
 * WHY: the nav is `position: sticky; top: 0` and, below 1024px, has no
 * hamburger — the links wrap to two or three rows, so it can occupy a third of
 * the viewport permanently. On the run-net console that is a third of the
 * screen taken from the script the operator is reading aloud.
 *
 * Scrolling down (reading forward) slides it away; scrolling back up brings it
 * straight back, as does returning to the top of the page or moving keyboard
 * focus into the nav — so the links are never more than one gesture away and
 * are never unreachable without a mouse.
 *
 * Publishes `data-nav-hidden` on <html> rather than toggling a React class, so
 * the CSS can also collapse the offsets that other sticky chrome stacks
 * against (see `--nav-offset` in ui.css). Inert at >= 1024px, and inert
 * wherever matchMedia is unavailable.
 */
export function useAutoHideNav(): void {
  const isNarrow = useMediaQuery(NARROW);

  React.useEffect(() => {
    const root = document.documentElement;
    const reveal = () => {
      delete root.dataset.navHidden;
    };

    if (!isNarrow) {
      reveal();
      return;
    }

    let lastY = window.scrollY;
    let frame = 0;
    // Separate from `frame` on purpose. If requestAnimationFrame runs its
    // callback synchronously (some polyfills and test environments do), the
    // handle is assigned AFTER the callback has already cleared it, so a
    // handle-based guard latches at "scheduled" forever and the nav stops
    // responding to scroll. A flag set before the call cannot invert.
    let scheduled = false;

    const evaluate = () => {
      scheduled = false;
      const y = window.scrollY;
      const delta = y - lastY;

      // At the top of the document the nav always shows: that is where someone
      // who wants to navigate goes looking for it.
      if (y <= ARM_AFTER_PX) {
        lastY = y;
        reveal();
        return;
      }
      if (Math.abs(delta) < MIN_DELTA_PX) return;
      lastY = y;
      if (delta > 0) root.dataset.navHidden = 'true';
      else reveal();
    };

    const onScroll = () => {
      // Coalesce to one read per frame — scroll fires far faster than paint,
      // and reading scrollY per event forces layout on every one of them.
      if (scheduled) return;
      scheduled = true;
      frame = window.requestAnimationFrame(evaluate);
    };

    // A hidden bar that keyboard focus can still enter is a trap: Tab would
    // move into links nobody can see. Revealing on focus keeps the nav
    // operable without a mouse or a scroll gesture.
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.hna-shell__nav')) reveal();
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('focusin', onFocusIn);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      // Never leave the attribute behind: it would hide the nav on a page
      // that does not run this hook.
      reveal();
    };
  }, [isNarrow]);
}
