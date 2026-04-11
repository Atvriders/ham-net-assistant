import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { formatFrequency, formatOffset, formatTone } from '../lib/format.js';

interface SummaryResponse {
  session: NetSession;
  net: Net;
  repeater: Repeater;
  checkIns: CheckIn[];
  stats: { count: number };
}

function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return 'in progress';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function SessionSummaryPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    const ctrl = new AbortController();
    apiFetch<SummaryResponse>(`/sessions/${sessionId}/summary`, { signal: ctrl.signal })
      .then(setData)
      .catch((e) => {
        if (isAbortError(e)) return;
        setErr((e as Error).message);
      });
    return () => ctrl.abort();
  }, [sessionId]);

  function downloadCsv() {
    if (!data) return;
    const from = data.session.startedAt;
    const to = data.session.endedAt ?? new Date().toISOString();
    const url = `/api/stats/export.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = 'checkins.csv';
    a.click();
  }

  async function copyLog() {
    if (!data) return;
    const lines = data.checkIns.map((ci) => `${ci.callsign} - ${ci.nameAtCheckIn}`).join('\n');
    await navigator.clipboard.writeText(lines);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (err) return <div style={{ padding: 24, color: 'var(--color-danger)' }}>{err}</div>;
  if (!data) return <div style={{ padding: 24 }}>Loading summary…</div>;

  const { session, net, repeater, checkIns } = data;

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto', display: 'grid', gap: 16 }}>
      <div>
        <Link to="/">&larr; Back to Dashboard</Link>
      </div>
      <Card>
        <h2 style={{ marginTop: 0 }}>{repeater.name}</h2>
        <div>{formatFrequency(repeater.frequency)}</div>
        <div>Offset: {formatOffset(repeater.offsetKhz)}</div>
        <div>Tone: {formatTone(repeater.toneHz)}</div>
        <div>Mode: {repeater.mode}</div>
      </Card>
      <Card>
        <h2 style={{ marginTop: 0 }}>{net.name}</h2>
        <div>Started: {new Date(session.startedAt).toLocaleString()}</div>
        <div>
          Ended: {session.endedAt ? new Date(session.endedAt).toLocaleString() : 'in progress'}
        </div>
        <div>Duration: {formatDuration(session.startedAt, session.endedAt)}</div>
        <div>Total check-ins: {checkIns.length}</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button onClick={downloadCsv}>Download sign-in CSV (this net range)</Button>
          <Button variant="secondary" onClick={copyLog}>
            {copied ? 'Copied' : 'Copy log to clipboard'}
          </Button>
        </div>
      </Card>
      <Card>
        <h3 style={{ marginTop: 0 }}>Check-ins</h3>
        {checkIns.length === 0 && <p>No check-ins recorded.</p>}
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {checkIns.map((ci) => (
            <li
              key={ci.id}
              style={{ borderBottom: '1px solid var(--color-border)', padding: '6px 0' }}
            >
              <strong>{ci.callsign}</strong> — {ci.nameAtCheckIn}
              <span style={{ float: 'right', color: 'var(--color-muted)' }}>
                {new Date(ci.checkedInAt).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
