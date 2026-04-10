import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { Input } from '../components/ui/Input.js';
import { ScriptEditor } from '../components/ScriptEditor.js';
import { formatFrequency, formatOffset, formatTone } from '../lib/format.js';

interface SessionResponse extends NetSession {
  checkIns: CheckIn[];
}
interface NetFull extends Net {
  repeater: Repeater;
}

export function RunNetPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [net, setNet] = useState<NetFull | null>(null);
  const [callsign, setCallsign] = useState('');
  const [name, setName] = useState('');
  const [script, setScript] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function loadSession() {
    if (!sessionId) return;
    const s = await apiFetch<SessionResponse>(`/sessions/${sessionId}`);
    setSession(s);
    const nets = await apiFetch<NetFull[]>('/nets');
    const n = nets.find((x) => x.id === s.netId) ?? null;
    setNet(n);
    if (n?.scriptMd && !script) setScript(n.scriptMd);
  }
  useEffect(() => {
    void loadSession();
  }, [sessionId]); // eslint-disable-line

  async function addCheckIn(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId) return;
    if (!/^[A-Z0-9]{3,7}$/.test(callsign)) return;
    if (!name.trim()) return;
    await apiFetch(`/sessions/${sessionId}/checkins`, {
      method: 'POST',
      body: JSON.stringify({ callsign, nameAtCheckIn: name }),
    });
    setCallsign('');
    setName('');
    inputRef.current?.focus();
    await loadSession();
  }

  async function undoLast() {
    const last = session?.checkIns[0];
    if (!last) return;
    await apiFetch(`/checkins/${last.id}`, { method: 'DELETE' });
    await loadSession();
  }

  async function endNet() {
    if (!sessionId) return;
    if (!confirm('End this net?')) return;
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ endedAt: new Date().toISOString() }),
    });
    nav('/stats');
  }

  if (!session || !net) return <div style={{ padding: 24 }}>Loading session…</div>;

  return (
    <div style={{ display: 'grid', gap: 16, padding: 16, gridTemplateColumns: '1fr 2fr 1fr' }}>
      <Card>
        <h2>{net.repeater.name}</h2>
        <div>{formatFrequency(net.repeater.frequency)}</div>
        <div>Offset: {formatOffset(net.repeater.offsetKhz)}</div>
        <div>Tone: {formatTone(net.repeater.toneHz)}</div>
        <div>Mode: {net.repeater.mode}</div>
        <hr />
        <div>
          Net: <strong>{net.name}</strong>
        </div>
        {net.theme && <div>Theme: {net.theme}</div>}
        <div style={{ marginTop: 16 }}>
          <Button variant="danger" onClick={endNet}>
            End net
          </Button>
        </div>
      </Card>
      <Card>
        <h3>Script</h3>
        <ScriptEditor value={script} onChange={setScript} />
      </Card>
      <Card>
        <h3>Check-ins ({session.checkIns.length})</h3>
        <form onSubmit={addCheckIn}>
          <label>
            Callsign
            <CallsignInput ref={inputRef} value={callsign} onChange={setCallsign} autoFocus />
          </label>
          <label>
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <Button type="submit">Add</Button>
            <Button type="button" variant="secondary" onClick={undoLast}>
              Undo
            </Button>
          </div>
        </form>
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
          {session.checkIns.map((ci) => (
            <li
              key={ci.id}
              style={{ borderBottom: '1px solid var(--color-border)', padding: '4px 0' }}
            >
              <strong>{ci.callsign}</strong> — {ci.nameAtCheckIn}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
