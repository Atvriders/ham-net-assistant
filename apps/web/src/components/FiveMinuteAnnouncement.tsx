import React from 'react';
import { formatStartLocal12h, minutesUntilNetStart } from '../lib/time.js';

/** Width of the pre-start announcement window, in minutes. */
const WINDOW_MINUTES = 5;
/**
 * Server auto-start grace window, in minutes. The server auto-starts a weekly
 * net's PREP session at its scheduled start time within this window; once it
 * has passed without the session going LIVE, the strip disappears and the
 * manual START NET button (always present) is the fallback. The client never
 * auto-starts anything itself.
 */
const GRACE_MINUTES = 15;
/** Tick cadence. 1s so the countdown has real seconds resolution. */
const TICK_MS = 1_000;

/** Module-level default so the effect dependency stays referentially stable. */
const defaultNow = () => new Date();

export interface FiveMinuteAnnouncementProps {
  /**
   * The net whose schedule drives the strip. Impromptu nets (or nets missing
   * a startLocal/timezone) never count down — the component renders nothing.
   */
  net: {
    kind: string;
    startLocal?: string | null;
    timezone?: string | null;
  };
  /** Injectable clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Fired once when the countdown crosses zero (i.e. the server should be
   * auto-starting the session right now). RunNetPage uses this to trigger an
   * immediate session refetch so the console flips to LIVE without waiting
   * for the next poll tick. Never fired again until the countdown goes
   * positive once more (next occurrence).
   */
  onStartDue?: () => void;
}

/**
 * PREP-stage countdown strip for the run-net console (weekly nets only).
 *
 * One strip, three states, all computed against **today's start wall-clock in
 * the net's IANA timezone** (see `minutesUntilNetStart` — pure seconds-aware
 * time-of-day math with midnight wrap handling):
 *
 *   1. Counting down (> 5 min out): calm "// AUTO-START IN MM:SS" line.
 *   2. Five-minute window (0 < t ≤ 5 min): the flashing warn banner
 *      ("// 5-MINUTE ANNOUNCEMENT — NET STARTS AT …") with the live countdown
 *      riding in the same strip. Flash lives in ui.css (`.hna-fivemin`) and is
 *      replaced by a static high-contrast state under
 *      `prefers-reduced-motion: reduce`.
 *   3. Start reached (grace window): "// STARTING…" while the server
 *      auto-starts the session; `onStartDue` fires once so the caller can
 *      refetch immediately. Past the grace the strip renders nothing.
 *
 * Ticks every second on its own interval (cleaned up on unmount; the caller
 * unmounts the component the moment the session goes LIVE, so the 1s timer
 * never runs on a live console). The ticking digits sit in a `role="timer"`
 * span (implicitly aria-live=off) so screen readers aren't spammed every
 * second, while the rare phase copy changes announce via `role="status"`.
 */
export function FiveMinuteAnnouncement({
  net,
  now = defaultNow,
  onStartDue,
}: FiveMinuteAnnouncementProps) {
  const [ts, setTs] = React.useState(() => now());

  // Impromptu nets (and weekly nets missing schedule fields) never announce.
  const scheduled =
    net.kind === 'weekly' && !!net.startLocal && !!net.timezone;

  React.useEffect(() => {
    if (!scheduled) return;
    const id = window.setInterval(() => setTs(now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [now, scheduled]);

  const mins = scheduled
    ? minutesUntilNetStart(net.startLocal as string, net.timezone as string, ts)
    : null;

  // Fire onStartDue exactly once per zero-crossing. Reset while the countdown
  // is positive so a console left open across the midnight wrap to the next
  // occurrence can fire again.
  const firedRef = React.useRef(false);
  React.useEffect(() => {
    if (mins === null) return;
    if (mins > 0) {
      firedRef.current = false;
      return;
    }
    if (mins > -GRACE_MINUTES && !firedRef.current) {
      firedRef.current = true;
      onStartDue?.();
    }
  }, [mins, onStartDue]);

  if (mins === null) return null;
  // Grace expired without the server starting the net — hide the strip; the
  // manual START NET button in the status strip is the fallback path.
  if (mins <= -GRACE_MINUTES) return null;

  const starting = mins <= 0;
  const inWindow = !starting && mins <= WINDOW_MINUTES;

  // Seconds-aware remainder derived from the fractional minutes (rounded to
  // dodge floating-point dust — minutesUntilNetStart is second-resolution).
  const totalSecs = Math.max(0, Math.round(mins * 60));
  const mm = String(Math.floor(totalSecs / 60)).padStart(2, '0');
  const ss = String(totalSecs % 60).padStart(2, '0');

  return (
    <div
      className={
        inWindow ? 'hna-fivemin hna-mono' : 'hna-prep-countdown hna-mono'
      }
      data-testid={inWindow ? 'five-minute-banner' : 'prep-countdown'}
    >
      {starting ? (
        <span role="status">{'// STARTING…'}</span>
      ) : (
        <>
          {inWindow && (
            <span role="status">
              {`// 5-MINUTE ANNOUNCEMENT — NET STARTS AT ${formatStartLocal12h(net.startLocal as string)} — `}
            </span>
          )}
          <span role="timer" aria-label="Time until scheduled auto-start">
            {`${inWindow ? '' : '// '}AUTO-START IN ${mm}:${ss}`}
          </span>
        </>
      )}
    </div>
  );
}
