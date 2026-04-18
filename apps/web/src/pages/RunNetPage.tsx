import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { Input } from '../components/ui/Input.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { useAuth } from '../auth/AuthProvider.js';
import {
  capitalizeFirst,
  formatFrequency,
  formatOffset,
  formatTone,
  displayCallsign,
} from '../lib/format.js';
import { ChatBox } from '../components/ChatBox.js';

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
  controlOp?: { callsign: string; name: string } | null;
}
interface DirectoryEntry {
  callsign: string;
  name: string;
}

export function RunNetPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const { data: session, refresh } = useAutoFetch<SessionResponse>(
    sessionId ? `/sessions/${sessionId}` : null,
    { intervalMs: 3000 },
  );
  const [net, setNet] = useState<NetFull | null>(null);
  const [callsign, setCallsign] = useState('');
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [endNotes, setEndNotes] = useState('');
  const [notesExpanded, setNotesExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastAutoFilledNameRef = useRef<string>('');
  const nameRef = useRef<string>('');
  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  // Derive net from session payload; fall back to /nets if the backend
  // didn't inline it (older responses).
  useEffect(() => {
    if (!session) return;
    if (session.net) {
      setNet(session.net);
      return;
    }
    const ctrl = new AbortController();
    apiFetch<NetFull[]>('/nets', { signal: ctrl.signal })
      .then((nets) => {
        setNet(nets.find((x) => x.id === session.netId) ?? null);
      })
      .catch((e) => {
        if (!isAbortError(e)) console.warn('net load failed', e);
      });
    return () => ctrl.abort();
  }, [session]);

  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<DirectoryEntry[]>('/users/directory', { signal: ctrl.signal })
      .then(setDirectory)
      .catch((e) => {
        if (!isAbortError(e)) console.warn('directory load failed', e);
      });
    return () => ctrl.abort();
  }, []);

  // Autofill name from member directory (instant), check-in history (debounced),
  // or FCC callook lookup (final fallback for first-time visitors).
  useEffect(() => {
    const cs = callsign.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,7}$/.test(cs)) return;

    const maybeSetName = (candidate: string) => {
      const current = nameRef.current;
      if (current === '' || current === lastAutoFilledNameRef.current) {
        setName(candidate);
        lastAutoFilledNameRef.current = candidate;
      }
    };

    const member = directory.find((d) => d.callsign === cs);
    if (member) {
      maybeSetName(member.name);
      return;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      apiFetch<{ callsign: string; name: string | null }>(
        `/checkins/callsign-history/${cs}`,
        { signal: ctrl.signal },
      )
        .then(async (res) => {
          if (res.name) {
            maybeSetName(res.name);
            return;
          }
          // Third fallback: FCC (callook.info) lookup for first-time visitors.
          try {
            const fcc = await apiFetch<{ name: string | null; found: boolean }>(
              `/callsign-lookup/${cs}`,
              { signal: ctrl.signal },
            );
            if (fcc.name) maybeSetName(fcc.name);
          } catch (e) {
            if (!isAbortError(e)) {
              /* network — ignore */
            }
          }
        })
        .catch((e) => {
          if (!isAbortError(e)) {
            /* network — ignore */
          }
        });
    }, 300);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [callsign, directory]);

  async function undoLast() {
    const last = session?.checkIns[0];
    if (!last) return;
    await apiFetch(`/checkins/${last.id}`, { method: 'DELETE' });
    await refresh();
  }

  function endNet() {
    if (!sessionId) return;
    setReviewOpen(true);
  }

  async function confirmEnd() {
    if (!sessionId) return;
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        endedAt: new Date().toISOString(),
        notes: endNotes.trim() || undefined,
      }),
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
    lastAutoFilledNameRef.current = '';
    inputRef.current?.focus();
    await refresh();
  }

  // Escape key opens the end-net review modal (Modal handles its own Escape to close)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !reviewOpen) {
        endNet();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, reviewOpen]);

  function onCallsignKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Backspace' && callsign === '') {
      e.preventDefault();
      void undoLast();
      return;
    }
    if (e.key === 'Enter') {
      // Prevent the datalist from swallowing Enter as a suggestion commit
      e.preventDefault();
      void addCheckIn();
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>
      <div className="hna-runnet-grid" style={{ display: 'grid', gap: 16, gridTemplateColumns: '1fr 2fr 1fr' }}>
      <Card>
        <h2>{net.repeater.name}</h2>
        <div>{formatFrequency(net.repeater.frequency)}</div>
        <div>Offset: {formatOffset(net.repeater.offsetKhz)}</div>
        <div>Tone: {formatTone(net.repeater.toneHz)}</div>
        <div>Mode: {net.repeater.mode}</div>
        <hr />
        <div>
          Net: <strong>{net.name}</strong>
          <span
            style={{
              fontSize: 11,
              color: 'var(--color-success)',
              marginLeft: 8,
            }}
          >
            ● live
          </span>
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
        {session.controlOp && (
          <div style={{ marginTop: 8 }}>
            <small>Control: {displayCallsign(session.controlOp.callsign)} — {session.controlOp.name}</small>
          </div>
        )}
        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {user && session.controlOpId !== user.id && (
            <Button
              variant="secondary"
              onClick={async () => {
                await apiFetch(`/sessions/${session.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ controlOpId: user.id }),
                });
                await refresh();
              }}
            >
              Take control
            </Button>
          )}
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
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addCheckIn();
                }
              }}
            />
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
      <ChatBox sessionId={session.id} />
      <Modal open={reviewOpen} onClose={() => setReviewOpen(false)}>
        <h2 style={{ marginTop: 0 }}>Review before ending net</h2>
        <div style={{ marginBottom: 8 }}>
          <strong>{net.name}</strong> — {net.repeater.name}
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            {session.checkIns.length} check-in{session.checkIns.length === 1 ? '' : 's'}
            {session.startedAt && (
              <>
                {' · '}
                {Math.max(
                  1,
                  Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000),
                )}{' '}
                min
              </>
            )}
          </div>
        </div>
        <ol
          style={{
            maxHeight: 320,
            overflowY: 'auto',
            margin: '8px 0',
            padding: '8px 12px 8px 28px',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            background: 'var(--color-bg-muted)',
          }}
        >
          {[...session.checkIns]
            .sort(
              (a, b) =>
                new Date(a.checkedInAt).getTime() - new Date(b.checkedInAt).getTime(),
            )
            .map((ci) => (
              <li key={ci.id} style={{ padding: '2px 0' }}>
                {new Date(ci.checkedInAt).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}{' '}
                — <strong>{displayCallsign(ci.callsign)}</strong> — {ci.nameAtCheckIn}
              </li>
            ))}
          {session.checkIns.length === 0 && (
            <li style={{ listStyle: 'none', color: 'var(--color-text-muted)' }}>
              No check-ins yet.
            </li>
          )}
        </ol>
        {notesExpanded ? (
          <label style={{ display: 'block', marginTop: 8 }}>
            Session notes (optional)
            <textarea
              className="hna-input"
              value={endNotes}
              onChange={(e) => setEndNotes(e.target.value)}
              style={{ width: '100%', minHeight: 80, marginTop: 4 }}
              autoFocus
            />
          </label>
        ) : (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setNotesExpanded(true)}
            style={{ marginTop: 8 }}
          >
            Add notes
          </Button>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 16,
          }}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => setReviewOpen(false)}
          >
            Keep running
          </Button>
          <Button type="button" variant="danger" onClick={confirmEnd}>
            End net
          </Button>
        </div>
      </Modal>
    </div>
  );
}
