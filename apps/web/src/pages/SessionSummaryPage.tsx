import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { ConfirmModal } from '../components/ui/ConfirmModal.js';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { useAuth } from '../auth/AuthProvider.js';
import { formatFrequency, formatOffset, formatTone, displayCallsign } from '../lib/format.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { buildSessionLogText } from '../lib/sessionLog.js';
import { EditCheckInModal } from '../components/EditCheckInModal.js';

interface NetLinkWithRepeater {
  id: string;
  repeaterId: string;
  repeater: Repeater;
  note?: string | null;
}
interface SummaryResponse {
  session: NetSession & {
    topicTitle?: string | null;
    topic?: { id: string; title: string } | null;
    controlOp?: { callsign: string; name: string } | null;
  };
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
  const isOfficerOrAdmin = user?.role === 'OFFICER' || user?.role === 'ADMIN';
  const { data, error: err, refresh } = useAutoFetch<SummaryResponse>(
    sessionId ? `/sessions/${sessionId}/summary` : null,
    { intervalMs: 30000 },
  );
  const [copied, setCopied] = useState(false);
  const [editingCheckIn, setEditingCheckIn] = useState<CheckIn | null>(null);
  const [confirmDeleteCheckInId, setConfirmDeleteCheckInId] = useState<string | null>(null);
  const [confirmDeleteSession, setConfirmDeleteSession] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const canModify = (ci: CheckIn): boolean => {
    if (user?.role === 'OFFICER' || user?.role === 'ADMIN') return true;
    const recent = Date.now() - new Date(ci.checkedInAt).getTime() < 5 * 60 * 1000;
    return ci.createdById === user?.id && recent;
  };
  const ownsRow = (ci: CheckIn): boolean => ci.createdById === user?.id;

  async function performDeleteCheckIn(id: string) {
    try {
      await apiFetch(`/checkins/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      console.warn('delete failed', e);
    } finally {
      setConfirmDeleteCheckInId(null);
    }
  }

  async function performDeleteSession() {
    if (!sessionId) return;
    try {
      await apiFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
      nav('/');
    } catch (e) {
      setDeleteErr((e as Error).message);
    } finally {
      setConfirmDeleteSession(false);
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

  function logText(): string {
    if (!data) return '';
    return buildSessionLogText({
      startedAt: data.session.startedAt,
      topic: data.session.topicTitle ?? data.session.topic?.title ?? null,
      controlOp: data.session.controlOp ?? null,
      checkIns: data.checkIns.map((c) => ({
        callsign: c.callsign,
        name: c.nameAtCheckIn,
        checkedInAt: c.checkedInAt,
        mode: c.mode,
      })),
    });
  }

  async function copyLog() {
    const text = logText();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (err) {
    return (
      <div style={{ padding: 24, color: 'var(--color-danger)' }} role="alert">
        {err}
      </div>
    );
  }
  if (!data) return <div style={{ padding: 24 }}>Loading summary…</div>;

  const { session, net, repeater, checkIns } = data;
  const totalCheckIns = checkIns.length;

  return (
    <div>
      <header className="hna-page-header">
        <p className="hna-page-marker">// 03 — SESSION LOG</p>
        <h1 className="hna-page-title">Session log</h1>
        <p className="hna-page-sub">Archived check-in log.</p>
        <div className="hna-page-actions">
          <Link to="/" style={{ textDecoration: 'none' }}>
            <Button variant="ghost" size="sm">← Dashboard</Button>
          </Link>
        </div>
      </header>

      {/* ===== Paperwork header ===== */}
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <h2
              className="hna-section-caption__title"
              style={{ margin: 0, fontSize: 28 }}
            >
              {net.name}
            </h2>
            <span
              className="hna-mono"
              style={{
                fontSize: 12,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--color-fg-muted)',
              }}
            >
              {new Date(session.startedAt).toLocaleString(undefined, {
                month: 'short',
                day: '2-digit',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })}
            </span>
          </div>
          <div className="hna-summary-grid">
            <div className="hna-summary-stat">
              <span className="hna-summary-stat__label">Check-ins</span>
              <span className="hna-summary-stat__value hna-summary-stat__value--accent">
                {totalCheckIns}
              </span>
            </div>
            <div className="hna-summary-stat">
              <span className="hna-summary-stat__label">Duration</span>
              <span className="hna-summary-stat__value">
                {formatDuration(session.startedAt, session.endedAt)}
              </span>
            </div>
            <div className="hna-summary-stat">
              <span className="hna-summary-stat__label">Control op</span>
              <span className="hna-summary-stat__value">
                {session.controlOp ? displayCallsign(session.controlOp.callsign) : '—'}
              </span>
            </div>
            <div className="hna-summary-stat">
              <span className="hna-summary-stat__label">Repeater</span>
              <span className="hna-summary-stat__value">
                {repeater.frequency.toFixed(3)}
              </span>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
              paddingTop: 'var(--space-3)',
              borderTop: '1px solid var(--color-border)',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
              color: 'var(--color-fg-muted)',
            }}
          >
            <span>
              <span
                className="hna-mono"
                style={{
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                }}
              >
                Repeater
              </span>
              : {repeater.name} · {formatFrequency(repeater.frequency)} ·{' '}
              {formatOffset(repeater.offsetKhz)} · tone {formatTone(repeater.toneHz)} · {repeater.mode}
            </span>
            {(session.topicTitle || session.topic) && (
              <span>
                <span
                  className="hna-mono"
                  style={{
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                  }}
                >
                  Topic
                </span>
                : {session.topicTitle ?? session.topic?.title}
              </span>
            )}
            <span>
              <span
                className="hna-mono"
                style={{
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                }}
              >
                Ended
              </span>
              :{' '}
              {session.endedAt
                ? new Date(session.endedAt).toLocaleString(undefined, { hour12: true })
                : 'in progress'}
            </span>
          </div>
          {net.links && net.links.length > 0 && (
            <div
              style={{
                paddingTop: 'var(--space-3)',
                borderTop: '1px solid var(--color-border)',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
              }}
            >
              <span
                className="hna-mono"
                style={{
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--color-fg-muted)',
                  marginRight: 8,
                }}
              >
                Linked
              </span>
              {net.links.map((l, idx) => (
                <span key={l.id} style={{ marginRight: 12 }}>
                  {idx > 0 ? '· ' : ''}
                  {l.repeater.name} ({formatFrequency(l.repeater.frequency)}{' '}
                  {formatOffset(l.repeater.offsetKhz)})
                </span>
              ))}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              flexWrap: 'wrap',
              marginTop: 'var(--space-2)',
            }}
          >
            <Button onClick={downloadCsv}>Download sign-in CSV (this net range)</Button>
            <Button variant="secondary" onClick={copyLog}>
              {copied ? 'Copied' : 'Copy log to clipboard'}
            </Button>
          </div>
        </div>
      </Card>

      {/* ===== Roster table ===== */}
      <SectionDivider>ROSTER</SectionDivider>
      <Card>
        <header className="hna-section-caption">
          <h3 className="hna-section-caption__title">
            <span className="hna-cap hna-cap--accent" style={{ margin: 0 }}>
              [ ROSTER ]
            </span>
          </h3>
          <span className="hna-section-caption__count">
            [ {totalCheckIns} CHECKED IN ]
          </span>
        </header>
        {checkIns.length === 0 ? (
          <div className="hna-log-table__empty">No check-ins recorded.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="hna-log-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Callsign</th>
                  <th scope="col">Name</th>
                  <th scope="col">Check-in</th>
                  <th scope="col">Comment</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {[...checkIns]
                  .sort(
                    (a, b) =>
                      new Date(a.checkedInAt).getTime() -
                      new Date(b.checkedInAt).getTime(),
                  )
                  .map((ci, idx) => {
                    const recent =
                      Date.now() - new Date(ci.checkedInAt).getTime() < 5 * 60 * 1000;
                    const canEdit = canModify(ci);
                    const showDisabledHint =
                      !canEdit && ownsRow(ci) && !recent;
                    return (
                      <tr key={ci.id}>
                        <td className="hna-log-table__idx">
                          #{String(idx + 1).padStart(2, '0')}
                        </td>
                        <td className="hna-log-table__cs">
                          {displayCallsign(ci.callsign)}
                          {ci.mode === 'echolink' && (
                            <span
                              className="hna-chip"
                              data-testid="echolink-chip"
                              style={{ marginLeft: 6 }}
                              aria-label="Checked in via EchoLink"
                            >
                              ECHOLINK
                            </span>
                          )}
                        </td>
                        <td>{ci.nameAtCheckIn}</td>
                        <td className="hna-log-table__time">
                          {new Date(ci.checkedInAt).toLocaleTimeString(undefined, {
                            hour: 'numeric',
                            minute: '2-digit',
                            hour12: true,
                          })}
                        </td>
                        <td style={{ color: 'var(--color-fg-muted)' }}>
                          {ci.comment ?? ''}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            onClick={() => canEdit && setEditingCheckIn(ci)}
                            className="hna-roster__btn"
                            disabled={!canEdit}
                            aria-label={
                              canEdit
                                ? 'Edit check-in'
                                : 'Editable for 5 minutes — ask an officer for changes after that'
                            }
                            title={
                              canEdit
                                ? 'Edit'
                                : showDisabledHint
                                  ? 'Editable for 5 minutes — ask an officer for changes after that'
                                  : 'Editing requires officer role'
                            }
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              canEdit && setConfirmDeleteCheckInId(ci.id)
                            }
                            className="hna-roster__btn"
                            data-variant="danger"
                            disabled={!canEdit}
                            aria-label={
                              canEdit
                                ? 'Delete check-in'
                                : 'Editable for 5 minutes — ask an officer for changes after that'
                            }
                            title={
                              canEdit
                                ? 'Delete'
                                : showDisabledHint
                                  ? 'Editable for 5 minutes — ask an officer for changes after that'
                                  : 'Deleting requires officer role'
                            }
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ===== Officer stats ===== */}
      {isOfficerOrAdmin && (
        <>
          <SectionDivider>STATS</SectionDivider>
          <Card>
            <header className="hna-section-caption">
              <h3 className="hna-section-caption__title">
                <span className="hna-cap hna-cap--accent" style={{ margin: 0 }}>
                  [ STATS ]
                </span>
              </h3>
            </header>
            <div className="hna-summary-grid">
              <div className="hna-summary-stat">
                <span className="hna-summary-stat__label">Total check-ins</span>
                <span className="hna-summary-stat__value">{totalCheckIns}</span>
              </div>
              <div className="hna-summary-stat">
                <span className="hna-summary-stat__label">Started</span>
                <span className="hna-summary-stat__value" style={{ fontSize: 14 }}>
                  {new Date(session.startedAt).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })}
                </span>
              </div>
              <div className="hna-summary-stat">
                <span className="hna-summary-stat__label">Ended</span>
                <span className="hna-summary-stat__value" style={{ fontSize: 14 }}>
                  {session.endedAt
                    ? new Date(session.endedAt).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                      })
                    : '—'}
                </span>
              </div>
              <div className="hna-summary-stat">
                <span className="hna-summary-stat__label">Duration</span>
                <span className="hna-summary-stat__value">
                  {formatDuration(session.startedAt, session.endedAt)}
                </span>
              </div>
            </div>
          </Card>
        </>
      )}

      {/* ===== Admin danger zone ===== */}
      {isAdmin && (
        <>
          <SectionDivider>DANGER ZONE</SectionDivider>
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--space-2)',
            }}
          >
            <Button
              variant="ghost"
              onClick={() => setConfirmDeleteSession(true)}
            >
              Delete session
            </Button>
          </div>
          {deleteErr && (
            <div className="hna-input-error" role="alert" style={{ marginTop: 8, textAlign: 'right' }}>
              {deleteErr}
            </div>
          )}
        </>
      )}

      <EditCheckInModal
        open={editingCheckIn !== null}
        checkIn={editingCheckIn}
        onClose={() => setEditingCheckIn(null)}
        onSaved={refresh}
      />
      <ConfirmModal
        open={confirmDeleteCheckInId !== null}
        title="Delete check-in"
        message="Delete this check-in?"
        confirmLabel="Delete"
        onClose={() => setConfirmDeleteCheckInId(null)}
        onConfirm={() => {
          if (confirmDeleteCheckInId) void performDeleteCheckIn(confirmDeleteCheckInId);
        }}
      />
      <ConfirmModal
        open={confirmDeleteSession}
        title="Delete session"
        message="Delete this session and all its check-ins? This cannot be undone."
        confirmLabel="Delete"
        onClose={() => setConfirmDeleteSession(false)}
        onConfirm={performDeleteSession}
      />
    </div>
  );
}
