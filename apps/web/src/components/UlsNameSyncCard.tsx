import React from 'react';
import { apiFetch, errorMessage } from '../api/client.js';
import { Card } from './ui/Card.js';
import { Button } from './ui/Button.js';
import { displayCallsign } from '../lib/format.js';

interface Sample {
  callsign: string;
  from: string;
  to: string;
  rows?: number;
}
interface Side {
  scanned: number;
  changing: number;
  unchanged: number;
  noUlsName: number;
  samples: Sample[];
}
interface Preview {
  ulsRows: number;
  checkIns: Side;
  users: Side;
}
interface ApplyResult {
  snapshot: string | null;
  checkInsUpdated: number;
  usersUpdated: number;
  callsignsAffected: number;
  skippedNoUlsName: number;
}

const CONFIRM_PHRASE = 'REPLACE NAMES';

/**
 * Replace stored names with the name on the FCC licence.
 *
 * This rewrites the club's log in bulk and cannot be undone by pressing
 * something — so it is preview-first: nothing is written until the operator
 * has seen the actual count and a sample of the changes, and typed the
 * confirmation. The server takes a database snapshot before the first write,
 * and its path is reported here, because "there is a backup" is only useful if
 * you know where it is.
 */
export function UlsNameSyncCard() {
  const [includeUsers, setIncludeUsers] = React.useState(false);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [confirmText, setConfirmText] = React.useState('');
  const [result, setResult] = React.useState<ApplyResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function loadPreview() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const p = await apiFetch<Preview>(
        `/admin/uls/name-sync/preview?includeUsers=${includeUsers}`,
      );
      setPreview(p);
    } catch (e) {
      setErr(errorMessage(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<ApplyResult>('/admin/uls/name-sync', {
        method: 'POST',
        body: JSON.stringify({ includeUsers, confirm: CONFIRM_PHRASE }),
      });
      setResult(r);
      setPreview(null);
      setConfirmText('');
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const totalChanging =
    (preview?.checkIns.changing ?? 0) + (preview?.users.changing ?? 0);

  return (
    <Card>
      <p className="hna-cap hna-cap--accent" style={{ marginTop: 0 }}>
        [ REPLACE NAMES FROM FCC ULS ]
      </p>
      <p style={{ fontSize: 13, color: 'var(--color-fg-muted)', marginTop: 0 }}>
        Rewrites the name on every check-in to the one on that callsign&rsquo;s FCC
        licence, using the local ULS copy. Useful once, to make an imported or
        hand-typed log match the licence records. Callsigns the FCC has no name
        for are left exactly as they are — this never blanks a name.
      </p>

      <label
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 13, margin: '0 0 var(--space-3)',
        }}
      >
        <input
          type="checkbox"
          checked={includeUsers}
          onChange={(e) => {
            setIncludeUsers(e.target.checked);
            setPreview(null);
          }}
          data-testid="name-sync-include-users"
        />
        Also rename member accounts (not just the log)
      </label>

      {!preview && !result && (
        <Button onClick={() => void loadPreview()} disabled={busy} data-testid="name-sync-preview">
          {busy ? 'Checking…' : 'Preview changes'}
        </Button>
      )}

      {preview && (
        <div data-testid="name-sync-preview-result">
          {preview.ulsRows === 0 ? (
            <p className="hna-input-error" role="alert">
              The FCC licence data has not been loaded yet. Use{' '}
              <strong>Load names from FCC ULS</strong> above first.
            </p>
          ) : totalChanging === 0 ? (
            <p className="hna-mono" style={{ fontSize: 12 }} data-testid="name-sync-nothing">
              Nothing to change — every name already matches the FCC record.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 13, margin: '0 0 var(--space-2)' }}>
                <strong>{preview.checkIns.changing.toLocaleString()}</strong> check-in
                {preview.checkIns.changing === 1 ? '' : 's'}
                {includeUsers && (
                  <>
                    {' '}and <strong>{preview.users.changing.toLocaleString()}</strong>{' '}
                    member account{preview.users.changing === 1 ? '' : 's'}
                  </>
                )}{' '}
                would be renamed. {preview.checkIns.noUlsName.toLocaleString()} left
                alone (no FCC name on file).
              </p>
              <ul className="hna-mono hna-name-sync__samples">
                {preview.checkIns.samples.map((s) => (
                  // One callsign can appear several times — a station logged
                  // under two different misspellings is two rows here, and
                  // keying on the callsign alone made React treat them as one.
                  <li key={`${s.callsign}\u0000${s.from}`}>
                    <span className="hna-name-sync__cs">{displayCallsign(s.callsign)}</span>
                    <span className="hna-name-sync__from">{s.from || '(blank)'}</span>
                    <span aria-hidden="true">→</span>
                    <span className="hna-name-sync__to">{s.to}</span>
                  </li>
                ))}
              </ul>
              <p style={{ fontSize: 13, marginBottom: 4 }}>
                A database snapshot is taken before anything is written. Type{' '}
                <strong>{CONFIRM_PHRASE}</strong> to continue.
              </p>
              <input
                className="hna-input"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                aria-label={`Type ${CONFIRM_PHRASE} to confirm`}
                placeholder={CONFIRM_PHRASE}
                data-testid="name-sync-confirm-input"
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button
                  variant="danger"
                  onClick={() => void apply()}
                  disabled={busy || confirmText.trim() !== CONFIRM_PHRASE}
                  data-testid="name-sync-apply"
                >
                  {busy ? 'Replacing…' : 'Replace names'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPreview(null);
                    setConfirmText('');
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {result && (
        <div role="status" data-testid="name-sync-result">
          <p style={{ fontSize: 13 }}>
            Renamed {result.checkInsUpdated.toLocaleString()} check-in
            {result.checkInsUpdated === 1 ? '' : 's'}
            {result.usersUpdated > 0 && <> and {result.usersUpdated} member account(s)</>}
            {' '}across {result.callsignsAffected.toLocaleString()} callsign
            {result.callsignsAffected === 1 ? '' : 's'}.{' '}
            {/* This total spans check-ins AND member accounts when both were
                included, unlike the preview line above it, which is check-ins
                only — so it says "rows" rather than implying check-ins. */}
            {result.skippedNoUlsName.toLocaleString()} row
            {result.skippedNoUlsName === 1 ? '' : 's'} left alone (no FCC name
            on file).
          </p>
          {result.snapshot && (
            <p className="hna-mono" style={{ fontSize: 11, color: 'var(--color-fg-muted)' }}>
              Snapshot taken first: {result.snapshot}
            </p>
          )}
        </div>
      )}

      {err && (
        <p className="hna-input-error" role="alert" data-testid="name-sync-error">
          {err}
        </p>
      )}
    </Card>
  );
}
