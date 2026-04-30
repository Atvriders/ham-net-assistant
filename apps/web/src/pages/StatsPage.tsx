import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { ParticipationStats } from '@hna/shared';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { displayCallsign } from '../lib/format.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { buildSessionLogText } from '../lib/sessionLog.js';
import { useAuth } from '../auth/AuthProvider.js';
import { apiFetch } from '../api/client.js';

export function StatsPage() {
  const { data: stats, refresh } = useAutoFetch<ParticipationStats>(
    '/stats/participation',
    { intervalMs: 15000 },
  );
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  function download(url: string, filename: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  async function copySessionLog(
    sessionId: string,
    s: ParticipationStats['sessions'][number],
  ) {
    try {
      await navigator.clipboard.writeText(buildSessionLogText(s));
      setCopiedSessionId(sessionId);
      setTimeout(() => setCopiedSessionId(null), 1500);
    } catch {
      /* ignore — older browsers */
    }
  }

  async function deleteSession(id: string, label: string) {
    if (
      !confirm(
        `Delete session "${label}"? This soft-deletes the session and all its check-ins. An admin can restore it from the Recently deleted card on the Admin page.`,
      )
    ) {
      return;
    }
    try {
      await apiFetch(`/sessions/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  if (!stats) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div className="hna-container" style={{ maxWidth: 1000, margin: '0 auto', display: 'grid', gap: 16 }}>
      <Card>
        <h2>Participation</h2>
        <div>
          Range: {stats.range.from.slice(0, 10)} to {stats.range.to.slice(0, 10)}
        </div>
        <div>
          Total sessions: {stats.totalSessions} · Total check-ins: {stats.totalCheckIns}
        </div>
        <div className="hna-flex-wrap" style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Button onClick={() => download('/api/stats/export.csv', 'checkins.csv')}>
            Download CSV
          </Button>
          <Button onClick={() => download('/api/stats/export.pdf', 'participation.pdf')}>
            Download PDF
          </Button>
        </div>
      </Card>
      <Card>
        <h3>Check-ins per net</h3>
        {stats.perNet.length === 0 ? (
          <p>No participation data yet.</p>
        ) : (
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={stats.perNet}>
                <XAxis dataKey="netName" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="checkIns" fill="var(--color-primary)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
      <Card>
        <h3>Top members</h3>
        {stats.perMember.length === 0 ? (
          <p>No participation data yet.</p>
        ) : (
          <ol>
            {stats.perMember.slice(0, 10).map((m) => (
              <li key={m.callsign}>
                <span className="hna-callsign">{displayCallsign(m.callsign)}</span> — {m.name}: {m.count}
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card>
        <h3>Sessions</h3>
        {stats.sessions.length === 0 && <p>No sessions in range.</p>}
        {stats.sessions.map((s) => (
          <div
            key={s.id}
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--color-border)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <strong>{s.netName}</strong>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ opacity: 0.7, fontSize: 13 }}>
                  {new Date(s.startedAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    hour12: true,
                  })}
                </span>
                <Button
                  variant="secondary"
                  onClick={() => copySessionLog(s.id, s)}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  {copiedSessionId === s.id ? 'Copied ✓' : 'Copy log'}
                </Button>
                {isAdmin && (
                  <Button
                    variant="danger"
                    onClick={() =>
                      deleteSession(
                        s.id,
                        `${s.netName} — ${new Date(s.startedAt).toLocaleDateString()}`,
                      )
                    }
                    style={{ padding: '4px 10px', fontSize: 12 }}
                  >
                    Delete
                  </Button>
                )}
              </span>
            </div>
            {s.topic && <div>Topic: {s.topic}</div>}
            {s.controlOp && (
              <div>
                Control: <strong className="hna-callsign">{displayCallsign(s.controlOp.callsign)}</strong> —{' '}
                {s.controlOp.name}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              Check-ins ({s.checkIns.length}):
              <ol style={{ margin: '4px 0 0 20px', padding: 0 }}>
                {s.checkIns.map((c, i) => (
                  <li key={i} style={{ fontSize: 13 }}>
                    <strong className="hna-callsign">{displayCallsign(c.callsign)}</strong> — {c.name}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
