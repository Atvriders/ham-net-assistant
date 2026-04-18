import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { useAuth } from '../auth/AuthProvider.js';
import { formatFrequency, formatOffset, formatTone, displayCallsign } from '../lib/format.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { EditCheckInModal } from '../components/EditCheckInModal.js';

interface NetLinkWithRepeater {
  id: string;
  repeaterId: string;
  repeater: Repeater;
  note?: string | null;
}
interface SummaryResponse {
  session: NetSession & { topicTitle?: string | null; topic?: { id: string; title: string } | null };
  net: Net & { links?: NetLinkWithRepeater[] };
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
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { data, error: err, refresh } = useAutoFetch<SummaryResponse>(
    sessionId ? `/sessions/${sessionId}/summary` : null,
    { intervalMs: 30000 },
  );
  const [copied, setCopied] = useState(false);
  const [editingCheckIn, setEditingCheckIn] = useState<CheckIn | null>(null);

  const canModify = (ci: CheckIn): boolean => {
    if (user?.role === 'OFFICER' || user?.role === 'ADMIN') return true;
    const recent = Date.now() - new Date(ci.checkedInAt).getTime() < 5 * 60 * 1000;
    return ci.createdById === user?.id && recent;
  };

  async function deleteCheckIn(id: string) {
    if (!confirm('Delete this check-in?')) return;
    try {
      await apiFetch(`/checkins/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      console.warn('delete failed', e);
    }
  }

  async function deleteSession() {
    if (!sessionId) return;
    if (!confirm('Delete this session and all its check-ins? This cannot be undone.')) return;
    try {
      await apiFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
      nav('/');
    } catch (e) {
      alert((e as Error).message);
    }
  }

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
    <div className="hna-container" style={{ maxWidth: 900, margin: '0 auto', display: 'grid', gap: 16 }}>
      <div className="hna-flex-wrap" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Link to="/">&larr; Back to Dashboard</Link>
        {isAdmin && (
          <Button variant="danger" onClick={deleteSession}>
            Delete session
          </Button>
        )}
      </div>
      <Card>
        <h2 style={{ marginTop: 0 }}>{repeater.name}</h2>
        <div>{formatFrequency(repeater.frequency)}</div>
        <div>Offset: {formatOffset(repeater.offsetKhz)}</div>
        <div>Tone: {formatTone(repeater.toneHz)}</div>
        <div>Mode: {repeater.mode}</div>
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
      </Card>
      <Card>
        <h2 style={{ marginTop: 0 }}>{net.name}</h2>
        {(session.topicTitle || session.topic) && (
          <div>Topic: {session.topicTitle ?? session.topic?.title}</div>
        )}
        <div>Started: {new Date(session.startedAt).toLocaleString(undefined, { hour12: true })}</div>
        <div>
          Ended: {session.endedAt ? new Date(session.endedAt).toLocaleString(undefined, { hour12: true }) : 'in progress'}
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
              style={{
                borderBottom: '1px solid var(--color-border)',
                padding: '6px 0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>
                <strong>{displayCallsign(ci.callsign)}</strong> — {ci.nameAtCheckIn}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--color-muted)' }}>
                  {new Date(ci.checkedInAt).toLocaleTimeString(undefined, { hour12: true })}
                </span>
                {canModify(ci) && (
                  <>
                    <button
                      onClick={() => setEditingCheckIn(ci)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--color-fg)',
                        opacity: 0.7,
                        fontSize: 14,
                      }}
                      aria-label="Edit"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => deleteCheckIn(ci.id)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--color-danger)',
                        opacity: 0.7,
                        fontSize: 14,
                      }}
                      aria-label="Delete"
                    >
                      ×
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <EditCheckInModal
        open={editingCheckIn !== null}
        checkIn={editingCheckIn}
        onClose={() => setEditingCheckIn(null)}
        onSaved={refresh}
      />
    </div>
  );
}
