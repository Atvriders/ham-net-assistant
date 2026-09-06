import React from 'react';
import { apiFetch, errorMessage } from '../api/client.js';
import { Card } from './ui/Card.js';
import { Button } from './ui/Button.js';

interface UlsRun {
  outcome: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  sourceFileDate: string | null;
  callsigns: number | null;
  error: string | null;
}

export interface UlsStatus {
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  running: boolean;
  tableRows: number;
  lastRun: UlsRun | null;
  lastSuccess: UlsRun | null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** While an import is running, how often to ask how it is going. */
const POLL_MS = 4000;

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * FCC ULS mirror: status, and a button to pull it now.
 *
 * The import runs unattended once a week. When that run fails — the FCC was
 * down, the club's uplink dropped mid-transfer — a club would otherwise wait
 * another week with no idea why callsign lookups went quiet. This is the
 * "what happened" and the "try again now".
 *
 * It polls only while a run is in flight: the import takes minutes, and a
 * button that looks stuck is indistinguishable from one that did nothing.
 */
export function UlsMirrorCard() {
  const [status, setStatus] = React.useState<UlsStatus | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const s = await apiFetch<Partial<UlsStatus>>('/admin/uls', { signal });
      // Normalise rather than trust. This card sits on a page full of other
      // tools; a missing field must leave it blank, not throw and take the
      // whole Admin page down with it.
      setStatus(
        s && typeof s === 'object'
          ? {
              enabled: s.enabled !== false,
              dayOfWeek: typeof s.dayOfWeek === 'number' ? s.dayOfWeek : 5,
              hour: typeof s.hour === 'number' ? s.hour : 0,
              running: s.running === true,
              tableRows: typeof s.tableRows === 'number' ? s.tableRows : 0,
              lastRun: s.lastRun ?? null,
              lastSuccess: s.lastSuccess ?? null,
            }
          : null,
      );
      return s;
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setErr(errorMessage(e));
      return null;
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Poll only while running — no reason to ask every few seconds about a
  // database that changes once a week.
  React.useEffect(() => {
    if (!status?.running) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [status?.running, load]);

  async function startImport() {
    setStarting(true);
    setErr(null);
    try {
      await apiFetch('/admin/uls/import', { method: 'POST' });
      await load();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  const running = status?.running ?? false;
  const disabled = status ? !status.enabled : false;

  return (
    <Card>
      <p className="hna-cap hna-cap--accent" style={{ marginTop: 0 }}>
        [ FCC ULS MIRROR ]
      </p>
      <p style={{ fontSize: 13, color: 'var(--color-fg-muted)', marginTop: 0 }}>
        A local copy of the FCC amateur licence database, so callsign lookups
        during a net do not depend on an outside service being up. It refreshes
        itself every {DAYS[status?.dayOfWeek ?? 5] ?? 'week'}; load it now if
        that run failed or you have just set the club up.
      </p>

      {status && (
        <dl className="hna-uls-facts hna-mono" data-testid="uls-facts">
          <div>
            <dt>Callsigns on file</dt>
            <dd data-testid="uls-rows">
              {(status.tableRows ?? 0).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt>Last loaded</dt>
            <dd>{when(status.lastSuccess?.finishedAt ?? null)}</dd>
          </div>
          <div>
            <dt>FCC file date</dt>
            <dd>{status.lastSuccess?.sourceFileDate ?? '—'}</dd>
          </div>
        </dl>
      )}

      {status?.lastRun?.outcome === 'failed' && (
        <p className="hna-input-error" role="alert" data-testid="uls-last-error">
          Last attempt ({when(status.lastRun.startedAt)}) failed:{' '}
          {status.lastRun.error ?? 'no reason recorded'}
        </p>
      )}

      {disabled && (
        <p
          className="hna-mono"
          data-testid="uls-disabled"
          style={{ fontSize: 12, color: 'var(--color-fg-muted)' }}
        >
          Turned off on this server (ULS_IMPORT_ENABLED=false). It downloads
          about 155 MB each time, so whoever runs the container decides.
        </p>
      )}

      <Button onClick={() => void startImport()} disabled={running || starting || disabled}>
        {running ? 'Loading from FCC…' : 'Load names from FCC ULS'}
      </Button>

      {running && (
        <p
          className="hna-mono"
          role="status"
          data-testid="uls-running"
          style={{ marginTop: 8, fontSize: 12, color: 'var(--color-fg-muted)' }}
        >
          Downloading and importing — this takes a few minutes. You can leave
          this page; it keeps going.
        </p>
      )}

      {err && (
        <p className="hna-input-error" role="alert" data-testid="uls-error">
          {err}
        </p>
      )}
    </Card>
  );
}
