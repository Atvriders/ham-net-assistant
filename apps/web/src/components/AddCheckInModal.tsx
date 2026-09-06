import React from 'react';
import { apiFetch, errorMessage } from '../api/client.js';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { CallsignInput } from './CallsignInput.js';
import { resolveCallsignName, useDirectory, CALLSIGN_RE } from '../lib/callsignName.js';

export interface AddCheckInModalProps {
  open: boolean;
  sessionId: string;
  onClose: () => void;
  onAdded: () => void;
}

/**
 * Add a station to a log after the fact.
 *
 * A net is run by ear: a station calls, the operator writes it down, and
 * sometimes one is missed — heard on the air but never typed. Without this the
 * only records of that station are the operator's memory and the recording, so
 * the club's log is simply wrong and cannot be corrected.
 *
 * The entry's timestamp is the moment it is actually saved, not a guess at
 * when the station called: the log should show plainly that this line was
 * added afterwards. Where it belongs in the running order is a separate
 * question, answered by reordering.
 */
export function AddCheckInModal({ open, sessionId, onClose, onAdded }: AddCheckInModalProps) {
  const [callsign, setCallsign] = React.useState('');
  const [name, setName] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [mode, setMode] = React.useState<'rf' | 'echolink'>('rf');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [lookingUp, setLookingUp] = React.useState(false);
  const directory = useDirectory();
  /** The last name this dialog filled in — never overwrite the operator's. */
  const autoFilled = React.useRef('');

  React.useEffect(() => {
    if (!open) return;
    setCallsign(''); setName(''); setComment(''); setMode('rf'); setErr(null);
    autoFilled.current = '';
  }, [open]);

  // Same chain the run-net console uses: club directory, then this station's
  // own check-in history, then the FCC licence. Debounced, and it never
  // overwrites a name the operator typed.
  React.useEffect(() => {
    if (!open) return;
    const cs = callsign.trim().toUpperCase();
    if (!CALLSIGN_RE.test(cs)) return;
    if (name.trim() !== '' && name !== autoFilled.current) return;
    const ctrl = new AbortController();
    setLookingUp(true);
    const timer = window.setTimeout(() => {
      void resolveCallsignName({ callsign: cs, directory, signal: ctrl.signal })
        .then((found) => {
          if (!found) return;
          setName((current) => {
            if (current.trim() !== '' && current !== autoFilled.current) return current;
            autoFilled.current = found;
            return found;
          });
        })
        .finally(() => setLookingUp(false));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
      setLookingUp(false);
    };
  }, [callsign, name, directory, open]);

  async function save() {
    if (!callsign.trim() || !name.trim()) {
      setErr('A callsign and a name are both needed for the log.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/sessions/${sessionId}/checkins`, {
        method: 'POST',
        body: JSON.stringify({
          callsign: callsign.trim().toUpperCase(),
          nameAtCheckIn: name.trim(),
          comment: comment.trim() === '' ? null : comment.trim(),
          mode,
        }),
      });
      onAdded();
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a missed station">
      <div className="hna-stack" data-testid="add-checkin-modal">
        <p style={{ fontSize: 13, color: 'var(--color-fg-muted)', marginTop: 0 }}>
          For a station that was heard but never logged. It is added at the end
          of the log with today&rsquo;s time; use Reorder to move it to where it
          was heard.
        </p>
        <div className="hna-field">
          <label htmlFor="add-checkin-callsign">Callsign</label>
          <CallsignInput id="add-checkin-callsign" value={callsign} onChange={setCallsign} autoFocus />
        </div>
        <div className="hna-field">
          <label htmlFor="add-checkin-name">Name</label>
          <Input
            id="add-checkin-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {lookingUp && name.trim() === '' && (
            <p
              className="hna-mono"
              data-testid="add-checkin-looking-up"
              style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--color-fg-subtle)' }}
            >
              Looking up name…
            </p>
          )}
        </div>
        <div className="hna-field" role="group" aria-label="Participation method">
          <span
            className="hna-mono"
            style={{
              fontSize: 11, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: 'var(--color-fg-muted)',
            }}
          >
            Mode
          </span>
          <div style={{ display: 'inline-flex', gap: 4, marginTop: 4 }}>
            <button
              type="button"
              className={mode === 'rf' ? 'hna-chip hna-chip--accent' : 'hna-chip hna-chip--off'}
              style={{ cursor: 'pointer' }}
              aria-pressed={mode === 'rf'}
              onClick={() => setMode('rf')}
            >
              [ RF ]
            </button>
            <button
              type="button"
              className={mode === 'echolink' ? 'hna-chip hna-chip--accent' : 'hna-chip hna-chip--off'}
              style={{ cursor: 'pointer' }}
              aria-pressed={mode === 'echolink'}
              onClick={() => setMode('echolink')}
            >
              [ ECHOLINK ]
            </button>
          </div>
        </div>
        <div className="hna-field">
          <label htmlFor="add-checkin-comment">Comment (optional)</label>
          <Input
            id="add-checkin-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={500}
          />
        </div>
        {err && <p className="hna-input-error" role="alert">{err}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Adding…' : 'Add to log'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
