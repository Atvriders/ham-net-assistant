import React from 'react';
import { formatStartLocal12h, minutesUntilNetStart } from '../lib/time.js';

/** Width of the pre-start announcement window, in minutes. */
const WINDOW_MINUTES = 5;
/** Re-check cadence. 15s is plenty for a 5-minute window and cheap to run. */
const TICK_MS = 15_000;

/** Module-level default so the effect dependency stays referentially stable. */
const defaultNow = () => new Date();

export interface FiveMinuteAnnouncementProps {
  /**
   * The net whose schedule drives the window. Impromptu nets (or nets missing
   * a startLocal/timezone) never announce — the component renders nothing.
   */
  net: {
    kind: string;
    startLocal?: string | null;
    timezone?: string | null;
  };
  /** Injectable clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * "// 5-MINUTE ANNOUNCEMENT" banner for the run-net console's PREP stage.
 *
 * Shows a flashing warn-colored strip when the current time is within five
 * minutes BEFORE a weekly net's scheduled start, computed against **today's
 * start wall-clock in the net's IANA timezone** (see `minutesUntilNetStart` —
 * pure time-of-day math with midnight wrap handling, so a 00:02 start still
 * announces at 23:58). The banner re-evaluates on its own 15-second interval
 * and disappears once the window passes; the caller (RunNetPage) unmounts it
 * when the session goes LIVE.
 *
 * The flash animation lives in ui.css (`.hna-fivemin`) and is replaced by a
 * static high-contrast highlight under `prefers-reduced-motion: reduce`.
 */
export function FiveMinuteAnnouncement({
  net,
  now = defaultNow,
}: FiveMinuteAnnouncementProps) {
  const [ts, setTs] = React.useState(() => now());

  React.useEffect(() => {
    const id = window.setInterval(() => setTs(now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [now]);

  // Impromptu nets have no meaningful schedule — never announce.
  if (net.kind !== 'weekly' || !net.startLocal || !net.timezone) return null;

  const mins = minutesUntilNetStart(net.startLocal, net.timezone, ts);
  if (mins === null || mins <= 0 || mins > WINDOW_MINUTES) return null;

  return (
    <div
      className="hna-fivemin hna-mono"
      role="status"
      data-testid="five-minute-banner"
    >
      {`// 5-MINUTE ANNOUNCEMENT — NET STARTS AT ${formatStartLocal12h(net.startLocal)}`}
    </div>
  );
}
