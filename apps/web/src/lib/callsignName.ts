import React from 'react';
import { apiFetch, isAbortError } from '../api/client.js';

export interface DirectoryEntry {
  callsign: string;
  name: string;
}

export const CALLSIGN_RE = /^[A-Z0-9]{3,7}$/;

/**
 * Club member directory, loaded once per mount.
 *
 * A club's own members are the majority of every net's check-ins, so this is
 * the answer for most callsigns and it costs no round trip once loaded.
 */
export function useDirectory(): DirectoryEntry[] {
  const [directory, setDirectory] = React.useState<DirectoryEntry[]>([]);
  React.useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<DirectoryEntry[]>('/users/directory', { signal: ctrl.signal })
      .then(setDirectory)
      .catch((e) => {
        if (!isAbortError(e)) console.warn('directory load failed', e);
      });
    return () => ctrl.abort();
  }, []);
  return directory;
}

/**
 * Resolve the name behind a callsign, in the order an operator would.
 *
 *   1. The club directory — a member, known locally and instantly.
 *   2. This callsign's own check-in history — how the club has logged this
 *      station before, which beats the licence record for people who go by a
 *      middle name or a nickname on the air.
 *   3. The FCC licence (local ULS mirror, falling back to callook).
 *
 * Extracted because three screens now offer a check-in form — the run-net
 * console, the add-a-missed-station dialog, and the session editor — and a
 * callsign that filled in a name on one but not another is exactly the kind of
 * inconsistency an operator reads as "broken".
 *
 * Returns null rather than throwing: a name that will not resolve is a thing
 * to type by hand, not an error to interrupt the operator with.
 */
export async function resolveCallsignName(opts: {
  callsign: string;
  directory?: DirectoryEntry[];
  signal?: AbortSignal;
}): Promise<string | null> {
  const cs = opts.callsign.trim().toUpperCase();
  if (!CALLSIGN_RE.test(cs)) return null;

  const member = opts.directory?.find((d) => d.callsign === cs);
  if (member?.name) return member.name;

  const quiet = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
    p.catch((e) => {
      if (!isAbortError(e)) {
        /* a lookup service being down must not block typing */
      }
      return fallback;
    });

  const [history, fcc] = await Promise.all([
    quiet(
      apiFetch<{ callsign: string; name: string | null }>(
        `/checkins/callsign-history/${cs}`,
        { signal: opts.signal },
      ),
      { callsign: cs, name: null },
    ),
    quiet(
      apiFetch<{ name: string | null; found: boolean }>(`/callsign-lookup/${cs}`, {
        signal: opts.signal,
      }),
      { name: null, found: false },
    ),
  ]);

  return history.name ?? fcc.name ?? null;
}
