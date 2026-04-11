import React from 'react';
import { Link } from 'react-router-dom';
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

export function Dashboard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
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

  return (
    <div className="hna-container" style={{ display: 'grid', gap: 16, maxWidth: 900, margin: '0 auto' }}>
      <Card>
        <h2>Next nets</h2>
        {upcoming.length === 0 && <p>No nets scheduled yet.</p>}
        {upcoming.map(({ n, when }) => (
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
              <Link to={`/nets/${s.net.id}/join`}>
                <Button>Join {s.net.name}</Button>
              </Link>
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
