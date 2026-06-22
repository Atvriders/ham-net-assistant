import { useMemo } from 'react';
import type { NetSession, Repeater } from '@hna/shared';
import { useAutoFetch } from './useAutoFetch.js';

/**
 * A row from `GET /api/nets/active` — a non-ended session with its embedded
 * net. `liveAt` is null while the session is in PREP (auto-opened or operator
 * opened but not yet started) and set once a control op presses START NET.
 */
export interface ActiveNetSession extends NetSession {
  net: { id: string; name: string; repeater: Repeater };
}

export interface LiveNetsResult {
  /** Sessions that have gone LIVE (liveAt set). Newest first. */
  live: ActiveNetSession[];
  /** Sessions opened but not yet started (liveAt null). Newest first. */
  prep: ActiveNetSession[];
  /** Convenience counts. */
  liveCount: number;
  prepCount: number;
  /** True until the first poll resolves. */
  loading: boolean;
}

/**
 * Poll `GET /api/nets/active` and split the active sessions into LIVE vs PREP.
 *
 * Reuses {@link useAutoFetch}, which is visibility-aware (it pauses polling
 * while the tab is hidden and catches up on return) and dedupes identical
 * JSON responses. Defaults to a ~17s interval — light enough for a global
 * shell indicator. Pass `enabled: false` (e.g. when signed out) to stop the
 * poll entirely.
 */
export function useLiveNets(opts: { enabled?: boolean; intervalMs?: number } = {}): LiveNetsResult {
  const { enabled = true, intervalMs = 17000 } = opts;
  const { data, loading } = useAutoFetch<ActiveNetSession[]>(
    enabled ? '/nets/active' : null,
    { intervalMs, enabled },
  );

  return useMemo(() => {
    const rows = data ?? [];
    const live = rows.filter((s) => s.liveAt != null);
    const prep = rows.filter((s) => s.liveAt == null);
    return {
      live,
      prep,
      liveCount: live.length,
      prepCount: prep.length,
      loading,
    };
  }, [data, loading]);
}
