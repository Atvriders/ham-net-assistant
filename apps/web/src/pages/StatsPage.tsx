import React, { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { ParticipationStats } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { displayCallsign } from '../lib/format.js';

export function StatsPage() {
  const [stats, setStats] = useState<ParticipationStats | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<ParticipationStats>('/stats/participation', { signal: ctrl.signal })
      .then(setStats)
      .catch((e) => {
        if (!isAbortError(e)) throw e;
      });
    return () => ctrl.abort();
  }, []);

  function download(url: string, filename: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  if (!stats) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto', display: 'grid', gap: 16 }}>
      <Card>
        <h2>Participation</h2>
        <div>
          Range: {stats.range.from.slice(0, 10)} to {stats.range.to.slice(0, 10)}
        </div>
        <div>
          Total sessions: {stats.totalSessions} · Total check-ins: {stats.totalCheckIns}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
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
                {displayCallsign(m.callsign)} — {m.name}: {m.count}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
