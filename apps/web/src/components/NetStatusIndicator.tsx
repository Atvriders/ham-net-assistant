import React from 'react';
import { Link } from 'react-router-dom';
import { LiveDot } from './ui/LiveDot.js';
import { useLiveNets } from '../lib/useLiveNets.js';

/**
 * Best-effort, permission-gated desktop notification that a net has started.
 *
 * Guards `typeof Notification` so it is safe in jsdom / non-browser
 * environments, and only fires when permission has already been granted — it
 * never prompts here (the lazy prompt lives in {@link NetStatusIndicator}).
 */
function notifyNetStarted(name: string): void {
  if (typeof Notification === 'undefined') return;
  try {
    if (Notification.permission === 'granted') {
      new Notification('Net started', { body: name });
    }
  } catch {
    /* ignore — notifications are best-effort */
  }
}

/**
 * Global "is any net live" indicator for the app shell.
 *
 * - When ≥1 net is LIVE: a pulsing red {@link LiveDot} + mono `N LIVE` chip.
 *   Links to `/run/:sessionId` of the first live session, or to the dashboard
 *   when more than one is live.
 * - When a net is in PREP (opened, waiting): a subtle amber `N PREP` chip
 *   linking to the first prep session's run page.
 * - PING: when the live count transitions 0 → ≥1, the chip gets a one-shot
 *   `is-pinging` pulse class (respecting `prefers-reduced-motion` via CSS) and
 *   — best-effort, only if permission was already granted — fires a Web
 *   Notification "Net started: <name>".
 *
 * Permission is requested lazily exactly once on first mount (never
 * re-prompted, never blocking). If denied/unavailable, the in-app pulse is the
 * only signal.
 */
export function NetStatusIndicator({
  enabled = true,
  intervalMs,
}: {
  enabled?: boolean;
  /** Poll cadence forwarded to the hook. Defaults to the hook's ~17s. */
  intervalMs?: number;
}) {
  const { live, prep, liveCount } = useLiveNets({ enabled, intervalMs });
  const [pinging, setPinging] = React.useState(false);
  const prevLiveCountRef = React.useRef(0);
  const pingTimerRef = React.useRef<number | null>(null);

  // Lazy, one-shot permission request — only when the indicator first mounts
  // and only if the user hasn't already decided. Never re-prompted.
  React.useEffect(() => {
    if (!enabled) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    try {
      void Notification.requestPermission();
    } catch {
      /* ignore — older browsers / blocked contexts */
    }
  }, [enabled]);

  // Detect the 0 → ≥1 transition: fire the pulse + (best-effort) notification.
  React.useEffect(() => {
    const prev = prevLiveCountRef.current;
    if (prev === 0 && liveCount > 0) {
      const started = live[0];
      if (started) notifyNetStarted(started.net.name);
      setPinging(true);
      if (pingTimerRef.current != null) window.clearTimeout(pingTimerRef.current);
      pingTimerRef.current = window.setTimeout(() => setPinging(false), 2400);
    }
    prevLiveCountRef.current = liveCount;
  }, [liveCount, live]);

  React.useEffect(() => {
    return () => {
      if (pingTimerRef.current != null) window.clearTimeout(pingTimerRef.current);
    };
  }, []);

  if (!enabled) return null;
  if (liveCount === 0 && prep.length === 0) return null;

  const liveHref =
    liveCount === 1 && live[0] ? `/run/${live[0].id}` : '/';
  const prepHref = prep[0] ? `/run/${prep[0].id}` : '/';

  return (
    <span className="hna-netstatus" data-testid="net-status-indicator">
      {liveCount > 0 && (
        <Link
          to={liveHref}
          className={`hna-chip hna-netstatus__live${pinging ? ' is-pinging' : ''}`}
          data-testid="net-status-live"
          data-pinging={pinging ? 'true' : undefined}
          aria-label={`${liveCount} net${liveCount === 1 ? '' : 's'} live`}
          title={
            liveCount === 1 && live[0]
              ? `Live: ${live[0].net.name}`
              : `${liveCount} nets live`
          }
        >
          <LiveDot label="Live" />
          <span className="hna-mono">{liveCount} LIVE</span>
        </Link>
      )}
      {prep.length > 0 && (
        <Link
          to={prepHref}
          className="hna-chip hna-netstatus__prep"
          data-testid="net-status-prep"
          aria-label={`${prep.length} net${prep.length === 1 ? '' : 's'} in prep`}
          title={
            prep.length === 1 && prep[0]
              ? `Prep: ${prep[0].net.name}`
              : `${prep.length} nets in prep`
          }
        >
          <span className="hna-mono">{prep.length} PREP</span>
        </Link>
      )}
    </span>
  );
}
