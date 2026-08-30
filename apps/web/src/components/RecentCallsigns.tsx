import React from 'react';
import { displayCallsign } from '../lib/format.js';

export interface RecentCallsign {
  callsign: string;
  name: string;
}

export interface RecentCallsignsProps {
  /** Regulars of this net, most recently heard first. */
  recent: RecentCallsign[];
  /** Callsigns already in this session's log — never offered twice. */
  alreadyCheckedIn: string[];
  /** Fill the entry with this station. */
  onPick: (entry: RecentCallsign) => void;
  /** Most chips to offer. Beyond this the strip is just a scroll chore. */
  limit?: number;
  disabled?: boolean;
}

const DEFAULT_LIMIT = 10;

/**
 * Tap-to-fill strip of this net's regulars.
 *
 * A net is mostly the same people every week, and on a phone every one of
 * those callsigns is otherwise typed by thumb while the operator is talking
 * on the air. This trades one row of vertical space — the strip scrolls
 * sideways, it never wraps — for skipping that typing entirely.
 *
 * Stations already in the log are filtered out rather than disabled: an
 * operator scanning for the next name should not have to read past the
 * people they have already worked, and a chip that cannot be tapped is
 * clutter wearing the costume of a control.
 */
export function RecentCallsigns({
  recent,
  alreadyCheckedIn,
  onPick,
  limit = DEFAULT_LIMIT,
  disabled = false,
}: RecentCallsignsProps): React.JSX.Element | null {
  const taken = React.useMemo(
    () => new Set(alreadyCheckedIn.map((c) => c.toUpperCase())),
    [alreadyCheckedIn],
  );
  const offered = recent
    .filter((r) => !taken.has(r.callsign.toUpperCase()))
    .slice(0, limit);

  // Nothing to offer (a brand-new net, or everyone is already in the log):
  // render nothing at all rather than an empty rail explaining itself.
  if (offered.length === 0) return null;

  return (
    <div className="hna-recent" data-testid="recent-callsigns">
      <span className="hna-recent__label hna-mono" aria-hidden="true">
        RECENT
      </span>
      <ul
        className="hna-recent__rail"
        aria-label="Recent check-ins — tap to fill"
      >
        {offered.map((r) => (
          <li key={r.callsign}>
            <button
              type="button"
              className="hna-recent__chip hna-mono"
              onClick={() => onPick(r)}
              disabled={disabled}
              // The visible chip is the callsign alone — the name would double
              // the strip's width for information the operator is about to see
              // in the entry field anyway.
              title={r.name ? `${r.callsign} — ${r.name}` : r.callsign}
              aria-label={r.name ? `Check in ${r.callsign}, ${r.name}` : `Check in ${r.callsign}`}
              data-testid={`recent-chip-${r.callsign}`}
            >
              {displayCallsign(r.callsign)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
