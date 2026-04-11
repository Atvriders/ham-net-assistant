import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch, isAbortError, ApiErrorException } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { useAuth } from '../auth/AuthProvider.js';
import {
  formatFrequency,
  formatOffset,
  formatTone,
  displayCallsign,
} from '../lib/format.js';

interface NetFull extends Net {
  repeater: Repeater;
  links?: Array<{ id: string; repeaterId: string; repeater: Repeater }>;
}
interface ActiveSessionResponse extends NetSession {
  checkIns: CheckIn[];
  net?: NetFull;
  topicTitle?: string | null;
  topic?: { id: string; title: string } | null;
}

export function JoinNetPage() {
  const { netId } = useParams<{ netId: string }>();
  const { user } = useAuth();
  const [session, setSession] = useState<ActiveSessionResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'none' | 'ok' | 'error'>(
    'loading',
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [checkedInAt, setCheckedInAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);

  async function loadActive(signal?: AbortSignal) {
    if (!netId) return;
    try {
      const s = await apiFetch<ActiveSessionResponse>(
        `/nets/${netId}/active-session`,
        { signal },
      );
      if (!mountedRef.current) return;
      setSession(s);
      setStatus('ok');
      // If we already appear in the list, lock the button.
      if (user) {
        const mine = s.checkIns.find((c) => c.callsign === user.callsign);
        if (mine) setCheckedInAt(mine.checkedInAt);
      }
    } catch (e) {
      if (isAbortError(e)) return;
      if (e instanceof ApiErrorException && e.status === 404) {
        setSession(null);
        setStatus('none');
      } else {
        setErrMsg((e as Error).message);
        setStatus('error');
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const ctrl = new AbortController();
    void loadActive(ctrl.signal);
    const interval = setInterval(() => {
      void loadActive();
    }, 10000);
    return () => {
      mountedRef.current = false;
      ctrl.abort();
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [netId]);

  async function checkMeIn() {
    if (!session || !user) return;
    setSubmitting(true);
    try {
      await apiFetch(`/sessions/${session.id}/checkins`, {
        method: 'POST',
        body: JSON.stringify({
          callsign: user.callsign,
          nameAtCheckIn: user.name,
        }),
      });
      setCheckedInAt(new Date().toISOString());
      await loadActive();
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (status === 'loading') {
    return <div style={{ padding: 24 }}>Loading…</div>;
  }
  if (status === 'error') {
    return (
      <div style={{ padding: 24, color: 'var(--color-danger)' }}>
        {errMsg ?? 'Error loading net.'}
      </div>
    );
  }
  if (status === 'none' || !session) {
    return (
      <div style={{ padding: 24, maxWidth: 700, margin: '0 auto' }}>
        <Card>
          <h2 style={{ marginTop: 0 }}>No net currently running</h2>
          <p>There is no active net on this repeater right now.</p>
        </Card>
      </div>
    );
  }

  const net = session.net;
  const topic = session.topicTitle ?? session.topic?.title ?? null;

  return (
    <div
      style={{
        padding: 24,
        maxWidth: 700,
        margin: '0 auto',
        display: 'grid',
        gap: 16,
      }}
    >
      <Card>
        <h2 style={{ marginTop: 0 }}>{net?.name ?? 'Net in progress'}</h2>
        {net?.repeater && (
          <div>
            <div>{net.repeater.name}</div>
            <div>{formatFrequency(net.repeater.frequency)}</div>
            <div>Offset: {formatOffset(net.repeater.offsetKhz)}</div>
            <div>Tone: {formatTone(net.repeater.toneHz)}</div>
          </div>
        )}
        {topic && (
          <div style={{ marginTop: 8 }}>
            <strong>Topic:</strong> {topic}
          </div>
        )}
        <div style={{ marginTop: 8 }}>Check-ins: {session.checkIns.length}</div>
      </Card>
      <Card>
        {checkedInAt ? (
          <Button disabled>
            ✓ Checked in at{' '}
            {new Date(checkedInAt).toLocaleTimeString(undefined, {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </Button>
        ) : (
          <Button onClick={checkMeIn} disabled={submitting || !user}>
            {submitting ? 'Checking in…' : 'Check me in'}
          </Button>
        )}
        {errMsg && (
          <div style={{ color: 'var(--color-danger)', marginTop: 8 }}>{errMsg}</div>
        )}
      </Card>
      <Card>
        <h3 style={{ marginTop: 0 }}>Check-ins ({session.checkIns.length})</h3>
        {session.checkIns.length === 0 && <p>No check-ins yet.</p>}
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {session.checkIns.map((ci) => (
            <li
              key={ci.id}
              style={{
                borderBottom: '1px solid var(--color-border)',
                padding: '6px 0',
              }}
            >
              <strong>{displayCallsign(ci.callsign)}</strong> — {ci.nameAtCheckIn}
              <span style={{ float: 'right', color: 'var(--color-muted)' }}>
                {new Date(ci.checkedInAt).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
