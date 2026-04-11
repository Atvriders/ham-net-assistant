import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import {
  capitalizeFirst,
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
  const {
    data: session,
    loading,
    error,
    refresh,
  } = useAutoFetch<ActiveSessionResponse>(
    netId ? `/nets/${netId}/active-session` : null,
    { intervalMs: 5000 },
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [checkedInAt, setCheckedInAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // When the polled session first arrives, lock the button if we're
  // already on the list.
  useEffect(() => {
    if (!session || !user) return;
    const mine = session.checkIns.find((c) => c.callsign === user.callsign);
    if (mine) setCheckedInAt((prev) => prev ?? mine.checkedInAt);
  }, [session, user]);

  async function checkMeIn() {
    if (!session || !user) return;
    setSubmitting(true);
    try {
      const capitalizedName = user.name ? capitalizeFirst(user.name) : '';
      await apiFetch(`/sessions/${session.id}/checkins`, {
        method: 'POST',
        body: JSON.stringify({
          callsign: user.callsign,
          nameAtCheckIn: capitalizedName,
        }),
      });
      setCheckedInAt(new Date().toISOString());
      await refresh();
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !session) {
    return <div style={{ padding: 24 }}>Loading…</div>;
  }
  // Distinguish "no active net" (404 -> treated as null by fetch error path)
  // from real errors. The hook surfaces 404 as an error; we show the "no
  // running net" card for that specific case.
  const is404 =
    error !== null && /\b(not found|no active)/i.test(error);
  if (error && !is404) {
    return (
      <div style={{ padding: 24, color: 'var(--color-danger)' }}>
        {error}
      </div>
    );
  }
  if (!session || is404) {
    return (
      <div className="hna-container" style={{ maxWidth: 700, margin: '0 auto' }}>
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
      className="hna-container"
      style={{
        maxWidth: 700,
        margin: '0 auto',
        display: 'grid',
        gap: 16,
      }}
    >
      <Card>
        <h2 style={{ marginTop: 0 }}>
          {net?.name ?? 'Net in progress'}
          <span
            style={{
              fontSize: 11,
              color: 'var(--color-success)',
              marginLeft: 8,
            }}
          >
            ● live
          </span>
        </h2>
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
