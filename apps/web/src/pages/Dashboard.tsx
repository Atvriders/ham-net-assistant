import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Net, Repeater, NetSession } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { dayName, nextOccurrence } from '../lib/time.js';

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
  const [nets, setNets] = useState<NetWithRepeater[]>([]);
  const [sessions, setSessions] = useState<NetSession[]>([]);
  const [activeSessions, setActiveSessions] = useState<ActiveSessionRow[]>([]);
  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<NetWithRepeater[]>('/nets', { signal: ctrl.signal })
      .then(setNets)
      .catch((e) => {
        if (!isAbortError(e)) throw e;
      });
    apiFetch<NetSession[]>('/sessions', { signal: ctrl.signal })
      .then(setSessions)
      .catch((e) => {
        if (!isAbortError(e)) throw e;
      });
    apiFetch<ActiveSessionRow[]>('/nets/active', { signal: ctrl.signal })
      .then(setActiveSessions)
      .catch((e) => {
        if (!isAbortError(e)) throw e;
      });
    return () => ctrl.abort();
  }, []);
  const upcoming = [...nets]
    .map((n) => ({ n, when: nextOccurrence(n.dayOfWeek, n.startLocal, n.timezone) }))
    .sort((a, b) => a.when.getTime() - b.when.getTime())
    .slice(0, 3);

  return (
    <div style={{ padding: 24, display: 'grid', gap: 16, maxWidth: 900, margin: '0 auto' }}>
      <Card>
        <h2>Next nets</h2>
        {upcoming.length === 0 && <p>No nets scheduled yet.</p>}
        {upcoming.map(({ n, when }) => (
          <div
            key={n.id}
            style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}
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
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 0',
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
          <div key={s.id}>
            {new Date(s.startedAt).toLocaleString(undefined, { hour12: true })} — {s.endedAt ? 'ended' : 'in progress'}
          </div>
        ))}
      </Card>
    </div>
  );
}
