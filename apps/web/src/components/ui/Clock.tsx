import React from 'react';
import './ui.css';

/**
 * Resolve a short, human timezone label for the current browser locale.
 *
 * Prefers the localized short tz name (e.g. "CST", "GMT+2") pulled from a
 * formatted `timeZoneName: 'short'` part. Falls back to the trailing segment
 * of the IANA zone id (e.g. "America/Chicago" -> "Chicago") when the short
 * name can't be derived. Returns an empty string if Intl is unavailable.
 */
function resolveTzLabel(): string {
  try {
    const dtf = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      timeZoneName: 'short',
    });
    const part = dtf.formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    if (part?.value) return part.value;
  } catch {
    /* fall through to the IANA-id fallback below */
  }
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) {
      const tail = zone.split('/').pop() ?? zone;
      return tail.replace(/_/g, ' ');
    }
  } catch {
    /* ignore — no tz label */
  }
  return '';
}

/** Zero-pad a number to two digits. */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 12-hour clock parts: hour 1-12 (no leading zero) + AM/PM meridiem. */
function to12h(d: Date): { hour: number; meridiem: 'AM' | 'PM' } {
  const h24 = d.getHours();
  return {
    hour: ((h24 + 11) % 12) + 1,
    meridiem: h24 >= 12 ? 'PM' : 'AM',
  };
}

/** Format a Date as local 12-hour `H:MM:SS AM|PM`. */
function formatTime(d: Date): string {
  const { hour, meridiem } = to12h(d);
  return `${hour}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${meridiem}`;
}

export interface ClockProps {
  /**
   * Narrow-width affordances. When `compact` is set the seconds are dropped
   * (`HH:MM`); when `hideTz` is set the timezone label is omitted. The shell
   * uses CSS to hide pieces at narrow widths, but these props let callers /
   * tests force the trimmed forms.
   */
  compact?: boolean;
  hideTz?: boolean;
}

/**
 * Live local-time readout for the app shell.
 *
 * Ticks every second as a calibrated mono 12-hour `H:MM:SS AM|PM`, followed
 * by the short local timezone label (e.g. `CST`). The seconds field and the
 * tz label are wrapped in their own spans so the shell's responsive rules can
 * hide them on narrow viewports without the clock ever overflowing the nav.
 *
 * Accessibility: carries an `aria-label` of "Current local time" and exposes
 * the full `H:MM:SS AM|PM TZ` string via the title attribute.
 */
export function Clock({ compact = false, hideTz = false }: ClockProps) {
  const [now, setNow] = React.useState(() => new Date());
  // Resolve the tz label once on mount — it doesn't change second-to-second.
  const tz = React.useMemo(() => resolveTzLabel(), []);

  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const { hour, meridiem } = to12h(now);
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const full = `${formatTime(now)}${tz ? ` ${tz}` : ''}`;

  return (
    <span
      className="hna-clock hna-mono"
      role="timer"
      aria-label="Current local time"
      title={full}
    >
      <span className="hna-clock__time">
        {hour}:{mm}
        {!compact && (
          <span className="hna-clock__seconds">:{ss}</span>
        )}
      </span>
      <span className="hna-clock__meridiem">{meridiem}</span>
      {!hideTz && tz && (
        <span className="hna-clock__tz" aria-hidden="true">
          {tz}
        </span>
      )}
    </span>
  );
}
