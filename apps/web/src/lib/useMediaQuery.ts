import React from 'react';

/**
 * Subscribe to a CSS media query from React.
 *
 * Used by the run-net console to decide whether the check-in entry is a
 * desktop form (all fields on screen) or the phone operator dock (collapsed
 * to callsign + Add). That distinction has to exist in the DOM, not just in
 * CSS: fields hidden by `display: none` are still reachable by a screen
 * reader and still focusable by Tab, so collapsing the dock visually while
 * leaving four live inputs in the tab order would be a worse experience than
 * not collapsing at all.
 *
 * Returns `false` where `matchMedia` is unavailable (jsdom, very old
 * browsers). That default is deliberate: it means "not narrow", so the full
 * form renders and nothing is ever hidden from a test or a browser we cannot
 * measure. Failing open costs a little screen space; failing closed would
 * hide the controls an operator needs mid-net.
 */
export function useMediaQuery(query: string): boolean {
  const get = React.useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  }, [query]);

  const [matches, setMatches] = React.useState(get);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    // addEventListener is the modern API; addListener is the Safari <14 spelling
    // and this app is used from phones that ship exactly that.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    const legacy = mql as MediaQueryList & {
      addListener?: (cb: () => void) => void;
      removeListener?: (cb: () => void) => void;
    };
    legacy.addListener?.(onChange);
    return () => legacy.removeListener?.(onChange);
  }, [query]);

  return matches;
}
