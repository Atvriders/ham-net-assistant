import { useMemo } from 'react';
import type { OnlineUser } from '@hna/shared';
import { useAutoFetch } from './useAutoFetch.js';

/**
 * Poll the presence roster and expose helpers to test whether a member is
 * currently online. Online status is keyed by both user id and callsign so
 * callers can match whichever identifier they have on hand.
 */
export function usePresence(): {
  online: OnlineUser[];
  isOnlineById: (id: string | null | undefined) => boolean;
  isOnlineByCallsign: (callsign: string | null | undefined) => boolean;
} {
  const { data } = useAutoFetch<OnlineUser[]>('/presence/online', {
    intervalMs: 30000,
  });
  const online = useMemo(() => data ?? [], [data]);
  const ids = useMemo(() => new Set(online.map((u) => u.id)), [online]);
  const callsigns = useMemo(
    () => new Set(online.map((u) => u.callsign.toUpperCase())),
    [online],
  );
  return {
    online,
    isOnlineById: (id) => (id ? ids.has(id) : false),
    isOnlineByCallsign: (cs) => (cs ? callsigns.has(cs.toUpperCase()) : false),
  };
}
