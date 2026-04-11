import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { Input } from '../components/ui/Input.js';
import {
  capitalizeFirst,
  formatFrequency,
  formatOffset,
  formatTone,
  displayCallsign,
} from '../lib/format.js';

interface NetLinkWithRepeater {
  id: string;
  repeaterId: string;
  repeater: Repeater;
  note?: string | null;
}
interface NetFull extends Net {
  repeater: Repeater;
  links?: NetLinkWithRepeater[];
}
interface SessionResponse extends NetSession {
  checkIns: CheckIn[];
  net?: NetFull;
  topicTitle?: string | null;
  topic?: { id: string; title: string } | null;
}
interface DirectoryEntry {
  callsign: string;
  name: string;
}

export function RunNetPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [net, setNet] = useState<NetFull | null>(null);
  const [callsign, setCallsign] = useState('');
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  async function loadSession(signal?: AbortSignal) {
    if (!sessionId) return;
    const s = await apiFetch<SessionResponse>(`/sessions/${sessionId}`, { signal });
    setSession(s);
    let n: NetFull | null = s.net ?? null;
    if (!n) {
      const nets = await apiFetch<NetFull[]>('/nets', { signal });
      n = nets.find((x) => x.id === s.netId) ?? null;
    }
    setNet(n);
  }

  useEffect(() => {
    const ctrl = new AbortController();
    loadSession(ctrl.signal).catch((e) => {
      if (!isAbortError(e)) throw e;
    });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<DirectoryEntry[]>('/users/directory', { signal: ctrl.signal })
      .then(setDirectory)
      .catch((e) => {
        if (!isAbortError(e)) console.warn('directory load failed', e);
      });
    return () => ctrl.abort();
  }, []);

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
    nav(`/sessions/${sessionId}/summary`);
  }

  async function addCheckIn(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!sessionId) return;
    if (!/^[A-Z0-9]{3,7}$/.test(callsign)) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const capitalized = capitalizeFirst(trimmed);
    const isMember = directory.some((d) => d.callsign === callsign);
    if (!isMember) {
      if (!confirm(`Log ${callsign} as visitor?`)) return;
    }
    await apiFetch(`/sessions/${sessionId}/checkins`, {
      method: 'POST',
      body: JSON.stringify({ callsign, nameAtCheckIn: capitalized }),
    });
    setCallsign('');
    setName('');
    inputRef.current?.focus();
    await loadSession();
  }

  // Escape key ends net
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        void endNet();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function onCallsignKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Backspace' && callsign === '') {
      e.preventDefault();
      void undoLast();
    }
  }

  if (!session || !net) return <div style={{ padding: 24 }}>Loading session…</div>;

  const suggestions =
    callsign.length > 0
      ? directory
          .filter((d) => d.callsign.includes(callsign.toUpperCase()))
          .slice(0, 8)
      : directory.slice(0, 8);

  return (
    <div className="hna-runnet-grid" style={{ display: 'grid', gap: 16, padding: 16, gridTemplateColumns: '1fr 2fr 1fr' }}>
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
        {(session.topicTitle || session.topic) && (
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--color-border)',
            }}
          >
            <strong>Topic</strong>
            <div style={{ marginTop: 4 }}>{session.topicTitle ?? session.topic?.title}</div>
          </div>
        )}
        {net.links && net.links.length > 0 && (
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--color-border)',
            }}
          >
            <strong>Linked:</strong>
            {net.links.map((l) => (
              <div key={l.id}>
                {l.repeater.name} — {formatFrequency(l.repeater.frequency)}{' '}
                {formatOffset(l.repeater.offsetKhz)}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="danger" onClick={endNet}>
            End net
          </Button>
        </div>
      </Card>
      <Card>
        <h3>Script</h3>
        <textarea
          className="hna-input"
          readOnly
          value={net?.scriptMd ?? ''}
          style={{
            minHeight: 400,
            width: '100%',
            fontFamily: 'ui-monospace, Menlo, monospace',
            background: 'var(--color-bg-muted)',
            cursor: 'default',
          }}
        />
      </Card>
      <Card>
        <h3>Check-ins ({session.checkIns.length})</h3>
        <form onSubmit={addCheckIn}>
          <label>
            Callsign
            <div onKeyDown={onCallsignKeyDown}>
              <CallsignInput
                ref={inputRef}
                value={callsign}
                onChange={setCallsign}
                autoFocus
                list="callsign-directory"
              />
            </div>
            <datalist id="callsign-directory">
              {suggestions.map((d) => (
                <option key={d.callsign} value={d.callsign}>
                  {d.name}
                </option>
              ))}
            </datalist>
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
              <strong>{displayCallsign(ci.callsign)}</strong> — {ci.nameAtCheckIn}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
