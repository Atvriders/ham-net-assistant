import React from 'react';
import { apiFetch, errorMessage } from '../api/client.js';
import { moveItem } from './reorder.js';

export interface LogEditing {
  /** A reorder request is in flight — disable the arrows so taps can't stack. */
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /**
   * Move the check-in at `index` by `delta` places and save the new order.
   * Returns true when the server accepted it.
   */
  move: (currentIds: string[], index: number, delta: -1 | 1) => Promise<boolean>;
}

/**
 * Reordering a session's check-in log, shared by the three places that show
 * one: the live console, the session summary, and the stats page's past nets.
 *
 * Extracted rather than copied because the interesting part is a contract with
 * the server — send the COMPLETE ordered id list, and treat a 409 as "your
 * copy of the log is stale" — and three hand-written copies of that would
 * drift. A reorder that behaved differently depending on which screen you did
 * it from would be worse than not offering it everywhere.
 */
export function useLogEditing(
  sessionId: string | null | undefined,
  onChanged: () => void | Promise<void>,
): LogEditing {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const move = React.useCallback(
    async (currentIds: string[], index: number, delta: -1 | 1): Promise<boolean> => {
      if (!sessionId) return false;
      const to = index + delta;
      if (to < 0 || to >= currentIds.length) return false;
      setBusy(true);
      setError(null);
      try {
        await apiFetch(`/sessions/${sessionId}/checkins/order`, {
          method: 'PATCH',
          body: JSON.stringify({ orderedIds: moveItem(currentIds, index, to) }),
        });
        await onChanged();
        return true;
      } catch (e) {
        // The server rejects a list that no longer matches the live log, which
        // is the case worth surfacing: someone else added or removed a station
        // while this screen was open.
        setError(errorMessage(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [sessionId, onChanged],
  );

  return { busy, error, clearError: () => setError(null), move };
}
