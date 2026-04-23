import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Net, Repeater, NetSession } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { useAuth } from '../auth/AuthProvider.js';
import { dayName, nextOccurrence } from '../lib/time.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';

interface NetWithRepeater extends Net {
  repeater: Repeater;
  links?: Array<{ id: string; repeaterId: string; repeater: Repeater }>;
}

interface ActiveSessionRow extends NetSession {
  net: { id: string; name: string; repeater: Repeater };
  topicTitle?: string | null;
  topic?: { id: string; title: string } | null;
}

function Countdown({ target }: { target: Date }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const diff = Math.max(0, target.getTime() - now);
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  const blink = Math.floor(now / 500) % 2 === 0;
  const sep = <span style={{ opacity: blink ? 1 : 0.25, transition: 'opacity 120ms' }}>:</span>;
  return (
    <div style={{
      fontFamily: 'var(--font-mono)',
      fontWeight: 700,
      fontSize: 32,
      letterSpacing: '0.02em',
      fontVariantNumeric: 'tabular-nums',
    }}>
      {days > 0 && <><span>{String(days).padStart(2, '0')}</span><span style={{ fontSize: 14, marginLeft: 4, marginRight: 8, opacity: 0.6 }}>d</span></>}
      <span>{String(hours).padStart(2, '0')}</span>
      {sep}
      <span>{String(minutes).padStart(2, '0')}</span>
      {sep}
      <span>{String(seconds).padStart(2, '0')}</span>
    </div>
  );
}

export function Dashboard() {
  const { user } = useAuth();
  const nav = useNavigate();
  const isAdmin = user?.role === 'ADMIN';
  const canControl = user?.role === 'OFFICER' || user?.role === 'ADMIN';

  async function takeControl(sessionId: string) {
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ controlOpId: user!.id }),
    });
    nav(`/run/${sessionId}`);
  }
  const { data: netsData } = useAutoFetch<NetWithRepeater[]>('/nets', {
    intervalMs: 10000,
  });
  const { data: sessionsData, refresh: refreshSessions } = useAutoFetch<
    NetSession[]
  >('/sessions', { intervalMs: 10000 });
  const { data: activeSessionsData } = useAutoFetch<ActiveSessionRow[]>(
    '/nets/active',
    { intervalMs: 5000 },
  );
  const nets = netsData ?? [];
  const sessions = sessionsData ?? [];
  const activeSessions = activeSessionsData ?? [];

  async function deleteSession(id: string) {
    if (!confirm('Delete this session and all its check-ins?')) return;
    try {
      await apiFetch(`/sessions/${id}`, { method: 'DELETE' });
      await refreshSessions();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const upcoming = [...nets]
    .map((n) => ({ n, when: nextOccurrence(n.dayOfWeek, n.startLocal, n.timezone) }))
    .sort((a, b) => a.when.getTime() - b.when.getTime())
    .slice(0, 3);

  const hero = upcoming[0];
  const followups = upcoming.slice(1);

  return (
    <div className="hna-container" style={{ display: 'grid', gap: 16, maxWidth: 900, margin: '0 auto' }}>
      {hero && (
        <Card className="hna-card-featured">
          <div className="hna-label">Next net</div>
          <h2 style={{ fontFamily: 'var(--font-mono)', letterSpacing: '-0.01em', marginTop: 4 }}>
            {hero.n.name}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 24, alignItems: 'end', marginTop: 12 }}>
            <div>
              <div className="hna-label" style={{ marginBottom: 4 }}>Starts in</div>
              <Countdown target={hero.when} />
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="hna-freq" style={{ fontSize: 20 }}>
                {hero.n.repeater.frequency.toFixed(3)} MHz
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, opacity: 0.7 }}>
                {hero.n.repeater.name}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.75 }}>
            {dayName(hero.when.getDay())}{' '}
            {hero.when.toLocaleString(undefined, {
              month: 'short', day: 'numeric',
              hour: 'numeric', minute: '2-digit', hour12: true,
            })}
          </div>
        </Card>
      )}
      {upcoming.length === 0 && (
        <Card>
          <h2>Next nets</h2>
          <p>No nets scheduled yet.</p>
        </Card>
      )}
      {followups.length > 0 && (
        <Card>
          <h3 style={{ marginTop: 0 }}>Following</h3>
          {followups.map(({ n, when }) => (
            <div
              key={n.id}
              className="hna-flex-wrap"
              style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', gap: 8 }}
            >
              <span>
                {n.name} — {n.repeater.name}
                {n.links && n.links.length > 0 ? ` (+${n.links.length} linked)` : ''}
              </span>
              <span>
                {dayName(when.getDay())}{' '}
                {when.toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}
              </span>
            </div>
          ))}
        </Card>
      )}
      {activeSessions.length > 0 && (
        <Card>
          <h2>Currently running</h2>
          {activeSessions.map((s) => (
            <div
              key={s.id}
              className="hna-flex-wrap"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 0',
                gap: 8,
              }}
            >
              <span>
                {s.net.name} — {s.net.repeater.name}
                {(s.topicTitle || s.topic) && (
                  <span style={{ color: 'var(--color-muted)' }}>
                    {' '}
                    · {s.topicTitle ?? s.topic?.title}
                  </span>
                )}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                {canControl && (
                  <Button variant="secondary" onClick={() => takeControl(s.id)}>
                    Take control
                  </Button>
                )}
                <Link to={`/nets/${s.net.id}/join`}>
                  <Button>Join {s.net.name}</Button>
                </Link>
              </div>
            </div>
          ))}
        </Card>
      )}
      <Card>
        <h2>Recent sessions</h2>
        {sessions.slice(0, 5).map((s) => (
          <div
            key={s.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              padding: '4px 0',
            }}
          >
            <span>
              {new Date(s.startedAt).toLocaleString(undefined, { hour12: true })} —{' '}
              {s.endedAt ? 'ended' : 'in progress'}
            </span>
            {isAdmin && (
              <Button
                variant="danger"
                onClick={() => deleteSession(s.id)}
                aria-label="Delete session"
              >
                Delete
              </Button>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
