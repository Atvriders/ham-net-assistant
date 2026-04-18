import React, { useState, useEffect } from 'react';
import type { CheckIn } from '@hna/shared';
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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (checkIn) {
      setCallsign(checkIn.callsign);
      setName(checkIn.nameAtCheckIn);
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
        body: JSON.stringify({ callsign, nameAtCheckIn: trimmed }),
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
    <Modal open={open} onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>Edit check-in</h3>
      <label>
        Callsign
        <CallsignInput value={callsign} onChange={setCallsign} autoFocus />
      </label>
      <label style={{ display: 'block', marginTop: 12 }}>
        Name
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {err && <div style={{ color: 'var(--color-danger)', marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button onClick={save} disabled={busy}>Save</Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      </div>
    </Modal>
  );
}
