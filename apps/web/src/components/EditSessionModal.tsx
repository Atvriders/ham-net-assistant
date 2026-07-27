import React, { useState, useEffect, useId } from 'react';
import type { ParticipationStats } from '@hna/shared';
import { apiFetch, ApiErrorException, isAbortError } from '../api/client.js';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { CallsignInput } from './CallsignInput.js';
import { displayCallsign } from '../lib/format.js';

type Session = ParticipationStats['sessions'][number];
type CheckInRow = Session['checkIns'][number];

interface ControlCandidate {
  id: string;
  callsign: string;
  name: string;
  role: string;
}

interface Props {
  open: boolean;
  session: Session | null;
  onClose: () => void;
  onSaved: () => void;
}

interface EditableCheckIn {
  id: string;
  callsign: string;
  name: string;
  removed: boolean;
  original: { callsign: string; name: string };
}

export function EditSessionModal({ open, session, onClose, onSaved }: Props) {
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [controlOpId, setControlOpId] = useState('');
  const [candidates, setCandidates] = useState<ControlCandidate[]>([]);
  const [checkIns, setCheckIns] = useState<EditableCheckIn[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const topicId = useId();
  const controlOpFieldId = useId();
  const notesId = useId();
  const dialogTitleId = useId();

  useEffect(() => {
    if (!session) return;
    setTopic(session.topic ?? '');
    setNotes(session.notes ?? '');
    setControlOpId(session.controlOpId ?? '');
    setCheckIns(
      session.checkIns.map((c: CheckInRow) => ({
        id: c.id,
        callsign: c.callsign,
        name: c.name,
        removed: false,
        original: { callsign: c.callsign, name: c.name },
      })),
    );
    setErr(null);
  }, [session]);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    apiFetch<ControlCandidate[]>('/users/control-candidates', { signal: ctrl.signal })
      .then(setCandidates)
      .catch((e) => {
        if (!isAbortError(e)) console.warn('control candidates load failed', e);
      });
    return () => ctrl.abort();
  }, [open]);

  function updateCheckIn(id: string, patch: Partial<EditableCheckIn>) {
    setCheckIns((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  async function save() {
    if (!session) return;
    setErr(null);

    // Validate edited (non-removed) check-ins before any write.
    for (const c of checkIns) {
      if (c.removed) continue;
      if (!/^[A-Z0-9]{3,7}$/.test(c.callsign)) {
        setErr(`Invalid callsign "${c.callsign}"`);
        return;
      }
      if (!c.name.trim()) {
        setErr('Each check-in needs a name');
        return;
      }
    }

    setBusy(true);
    try {
      await apiFetch(`/sessions/${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          topicTitle: topic.trim() || null,
          notes: notes.trim() || null,
          ...(controlOpId ? { controlOpId } : {}),
        }),
      });

      for (const c of checkIns) {
        if (c.removed) {
          await apiFetch(`/checkins/${c.id}`, { method: 'DELETE' });
          continue;
        }
        const changed =
          c.callsign !== c.original.callsign || c.name.trim() !== c.original.name;
        if (changed) {
          await apiFetch(`/checkins/${c.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ callsign: c.callsign, nameAtCheckIn: c.name.trim() }),
          });
        }
      }

      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiErrorException ? e.payload.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!session) return null;

  return (
    <Modal open={open} onClose={onClose} titleId={dialogTitleId}>
      <h3 id={dialogTitleId} style={{ marginTop: 0 }}>
        Edit session
      </h3>
      <div style={{ opacity: 0.7, fontSize: 13, marginBottom: 12 }}>
        {session.netName} — {new Date(session.startedAt).toLocaleString()}
      </div>

      <label htmlFor={topicId} style={{ display: 'block' }}>
        Topic
        <Input
          id={topicId}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Topic for this net"
          autoFocus
        />
      </label>

      <label
        htmlFor={controlOpFieldId}
        style={{ display: 'block', marginTop: 12 }}
      >
        Control operator
        <select
          id={controlOpFieldId}
          className="hna-input"
          value={controlOpId}
          onChange={(e) => setControlOpId(e.target.value)}
        >
          <option value="">— None —</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {displayCallsign(u.callsign)} — {u.name}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor={notesId} style={{ display: 'block', marginTop: 12 }}>
        Notes
        <textarea
          id={notesId}
          className="hna-input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Optional notes"
        />
      </label>

      <div style={{ marginTop: 16 }}>
        <strong>Check-ins ({checkIns.filter((c) => !c.removed).length})</strong>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {checkIns.map((c) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                opacity: c.removed ? 0.45 : 1,
              }}
            >
              <div style={{ flex: '0 0 110px' }}>
                <CallsignInput
                  value={c.callsign}
                  onChange={(v) => updateCheckIn(c.id, { callsign: v })}
                  disabled={c.removed}
                />
              </div>
              <Input
                value={c.name}
                onChange={(e) => updateCheckIn(c.id, { name: e.target.value })}
                disabled={c.removed}
                style={{ flex: 1 }}
              />
              <Button
                variant={c.removed ? 'secondary' : 'danger'}
                onClick={() => updateCheckIn(c.id, { removed: !c.removed })}
                style={{ padding: '4px 10px', fontSize: 12 }}
              >
                {c.removed ? 'Undo' : 'Remove'}
              </Button>
            </div>
          ))}
          {checkIns.length === 0 && (
            <div style={{ opacity: 0.7, fontSize: 13 }}>No check-ins logged.</div>
          )}
        </div>
      </div>

      {/* Announced on appearance, and shaped (border + tint) rather than
          coloured only — a validation failure here is the difference between
          saving and silently losing the operator's session edits. */}
      {err && (
        <div role="alert" className="hna-form-error" style={{ marginTop: 8 }}>
          {err}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button onClick={save} disabled={busy}>
          Save
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
