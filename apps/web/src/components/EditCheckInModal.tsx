import React, { useState, useEffect, useId } from 'react';
import type { CheckIn, CheckInMode } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { CallsignInput } from './CallsignInput.js';

interface Props {
  open: boolean;
  checkIn: CheckIn | null;
  onClose: () => void;
  onSaved: () => void;
}

export function EditCheckInModal({ open, checkIn, onClose, onSaved }: Props) {
  const [callsign, setCallsign] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<CheckInMode>('rf');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const callsignId = useId();
  const nameId = useId();
  const modeId = useId();
  const dialogTitleId = useId();

  useEffect(() => {
    if (checkIn) {
      setCallsign(checkIn.callsign);
      setName(checkIn.nameAtCheckIn);
      // Round-trip the participation method so officers correcting a
      // historical log preserve (or knowingly change) how the check-in was made.
      setMode(checkIn.mode ?? 'rf');
      setErr(null);
    }
  }, [checkIn]);

  async function save() {
    if (!checkIn) return;
    if (!/^[A-Z0-9]{3,7}$/.test(callsign)) {
      setErr('Invalid callsign');
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setErr('Name required');
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/checkins/${checkIn.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ callsign, nameAtCheckIn: trimmed, mode }),
      });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiErrorException ? e.payload.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} titleId={dialogTitleId}>
      <h3 id={dialogTitleId} style={{ marginTop: 0 }}>
        Edit check-in
      </h3>
      <label htmlFor={callsignId}>
        Callsign
        <CallsignInput
          id={callsignId}
          value={callsign}
          onChange={setCallsign}
          autoFocus
        />
      </label>
      <label htmlFor={nameId} style={{ display: 'block', marginTop: 12 }}>
        Name
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label htmlFor={modeId} style={{ display: 'block', marginTop: 12 }}>
        Mode
        <select
          id={modeId}
          data-testid="edit-checkin-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as CheckInMode)}
          className="hna-input"
          style={{ display: 'block', marginTop: 4 }}
        >
          <option value="rf">RF (local repeater)</option>
          <option value="echolink">EchoLink (VoIP)</option>
        </select>
      </label>
      {/* `role="alert"` so the failure is announced when it appears — the
          message is rendered far from the Save button the user just pressed.
          `.hna-form-error` carries a border + tint so the error does not read
          as "red text" alone (WCAG 1.4.1, and invisible to a monochrome or
          high-contrast display). */}
      {err && (
        <div role="alert" className="hna-form-error" style={{ marginTop: 8 }}>
          {err}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button onClick={save} disabled={busy}>Save</Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      </div>
    </Modal>
  );
}
