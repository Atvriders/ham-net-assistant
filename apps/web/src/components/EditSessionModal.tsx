import React, { useState, useEffect, useId } from 'react';
import type { ParticipationStats } from '@hna/shared';
import { apiFetch, ApiErrorException, isAbortError } from '../api/client.js';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { CallsignInput } from './CallsignInput.js';
import { displayCallsign } from '../lib/format.js';
import { resolveCallsignName, useDirectory, CALLSIGN_RE } from '../lib/callsignName.js';

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
  /** Server id, or a local `new-N` placeholder until this row is created. */
  id: string;
  callsign: string;
  name: string;
  removed: boolean;
  /** Added in this dialog and not yet saved. */
  isNew: boolean;
  original: { callsign: string; name: string };
}

/** Local ids for rows that do not exist server-side yet. */
let newRowCounter = 0;

export function EditSessionModal({ open, session, onClose, onSaved }: Props) {
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [controlOpId, setControlOpId] = useState('');
  const [candidates, setCandidates] = useState<ControlCandidate[]>([]);
  const [checkIns, setCheckIns] = useState<EditableCheckIn[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether any row moved. Everything in this dialog is staged and written on
  // Save, so the order is too — reordering immediately while removals waited
  // for Save would leave the log in a state the operator never asked for if
  // they then hit Cancel.
  const [orderChanged, setOrderChanged] = useState(false);
  const directory = useDirectory();
  // Rows whose name this dialog filled in. An operator's own typing is never
  // overwritten by a later lookup; a name we wrote ourselves is fair game when
  // the callsign changes again.
  const autoFilled = React.useRef<Map<string, string>>(new Map());
  const topicId = useId();
  const controlOpFieldId = useId();
  const notesId = useId();
  const dialogTitleId = useId();

  useEffect(() => {
    if (!session) return;
    setTopic(session.topic ?? '');
    setNotes(session.notes ?? '');
    setControlOpId(session.controlOpId ?? '');
    setOrderChanged(false);
    setCheckIns(
      session.checkIns.map((c: CheckInRow) => ({
        id: c.id,
        callsign: c.callsign,
        name: c.name,
        removed: false,
        isNew: false,
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

  // Fill in names for rows whose callsign looks complete and whose name is
  // still empty (or still holds a name we filled in). Debounced so typing a
  // callsign does not fire a lookup per keystroke, and aborted on unmount.
  useEffect(() => {
    const pending = checkIns.filter(
      (c) =>
        !c.removed &&
        CALLSIGN_RE.test(c.callsign.trim().toUpperCase()) &&
        (c.name.trim() === '' || autoFilled.current.get(c.id) === c.name),
    );
    if (pending.length === 0) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      for (const row of pending) {
        const cs = row.callsign.trim().toUpperCase();
        void resolveCallsignName({ callsign: cs, directory, signal: ctrl.signal })
          .then((name) => {
            if (!name) return;
            setCheckIns((rows) =>
              rows.map((r) => {
                if (r.id !== row.id) return r;
                // Re-check at apply time: the operator may have typed a name
                // (or changed the callsign again) while the lookup was in
                // flight.
                if (r.callsign.trim().toUpperCase() !== cs) return r;
                if (r.name.trim() !== '' && autoFilled.current.get(r.id) !== r.name) {
                  return r;
                }
                autoFilled.current.set(r.id, name);
                return { ...r, name };
              }),
            );
          })
          .catch(() => {
            /* a failed lookup just leaves the field for the operator */
          });
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [checkIns, directory]);

  /** Append a blank row for a station that was heard but never logged. */
  function addRow() {
    newRowCounter += 1;
    setCheckIns((rows) => [
      ...rows,
      {
        id: `new-${newRowCounter}`,
        callsign: '',
        name: '',
        removed: false,
        isNew: true,
        original: { callsign: '', name: '' },
      },
    ]);
    setOrderChanged(true);
  }

  /** Move a row one place, skipping over rows staged for removal. */
  function moveRow(index: number, delta: -1 | 1) {
    setCheckIns((rows) => {
      const to = index + delta;
      if (to < 0 || to >= rows.length) return rows;
      const next = rows.slice();
      const [moved] = next.splice(index, 1);
      next.splice(to, 0, moved as EditableCheckIn);
      return next;
    });
    setOrderChanged(true);
  }

  async function save() {
    if (!session) return;
    setErr(null);

    // Validate edited (non-removed) check-ins before any write.
    for (const c of checkIns) {
      if (c.removed) continue;
      if (!/^[A-Z0-9]{3,7}$/.test(c.callsign.trim().toUpperCase())) {
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

      // Order matters here. Removals and edits first, then creations — so the
      // order PATCH at the end can send the final, real id of every row that
      // survives. A new row has only a local `new-N` id until it is created.
      const finalIds: string[] = [];
      for (const c of checkIns) {
        if (c.removed) {
          // A row added and then removed in the same dialog never existed
          // server-side; deleting it would 404.
          if (!c.isNew) await apiFetch(`/checkins/${c.id}`, { method: 'DELETE' });
          continue;
        }
        if (c.isNew) {
          const created = await apiFetch<{ id: string }>(
            `/sessions/${session.id}/checkins`,
            {
              method: 'POST',
              body: JSON.stringify({
                callsign: c.callsign.trim().toUpperCase(),
                nameAtCheckIn: c.name.trim(),
              }),
            },
          );
          finalIds.push(created.id);
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
        finalIds.push(c.id);
      }

      // Persist the running order last, once every surviving row has a real
      // id. Skipped when nothing moved: the endpoint rewrites every row's
      // position, and there is no reason to do that for a topic-only edit.
      if (orderChanged && finalIds.length > 0) {
        await apiFetch(`/sessions/${session.id}/checkins/order`, {
          method: 'PATCH',
          body: JSON.stringify({ orderedIds: finalIds }),
        });
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
          {checkIns.map((c, idx) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                opacity: c.removed ? 0.45 : 1,
              }}
            >
              {/* The log records the order stations were HEARD, which is not
                  always the order they were typed. Times are left exactly as
                  recorded — only the running order changes. */}
              <span className="hna-log-table__move">
                <button
                  type="button"
                  className="hna-roster__move-btn"
                  onClick={() => moveRow(idx, -1)}
                  disabled={idx === 0 || busy}
                  aria-label={`Move ${c.callsign || 'new check-in'} earlier`}
                  data-testid={`session-move-up-${idx}`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="hna-roster__move-btn"
                  onClick={() => moveRow(idx, 1)}
                  disabled={idx === checkIns.length - 1 || busy}
                  aria-label={`Move ${c.callsign || 'new check-in'} later`}
                  data-testid={`session-move-down-${idx}`}
                >
                  ▼
                </button>
              </span>
              <div style={{ flex: '0 0 110px' }}>
                {/* These rows are a bare grid of inputs with no visible
                    labels, so each needs its own accessible name — otherwise a
                    screen-reader user hears "edit text" ten times over with no
                    way to tell which station they are changing. */}
                <CallsignInput
                  value={c.callsign}
                  onChange={(v) => updateCheckIn(c.id, { callsign: v })}
                  disabled={c.removed}
                  aria-label={`Callsign, check-in ${idx + 1}`}
                />
              </div>
              <Input
                value={c.name}
                onChange={(e) => updateCheckIn(c.id, { name: e.target.value })}
                disabled={c.removed}
                style={{ flex: 1 }}
                aria-label={`Name, check-in ${idx + 1}`}
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
        <div style={{ marginTop: 8 }}>
          <Button
            variant="secondary"
            onClick={addRow}
            disabled={busy}
            data-testid="session-add-checkin"
          >
            Add a missed station
          </Button>
          <p
            className="hna-mono"
            style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--color-fg-muted)' }}
          >
            Check-in times stay as recorded — only the order changes.
          </p>
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
