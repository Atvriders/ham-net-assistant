import React, { useId, useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { ParticipationStats } from '@hna/shared';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { ConfirmModal } from '../components/ui/ConfirmModal.js';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { displayCallsign } from '../lib/format.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { buildSessionLogText } from '../lib/sessionLog.js';
import { useAuth } from '../auth/AuthProvider.js';
import { apiFetch } from '../api/client.js';
import { EditSessionModal } from '../components/EditSessionModal.js';
import { AddCheckInModal } from '../components/AddCheckInModal.js';
import { useLogEditing } from '../lib/useLogEditing.js';

type SessionRow = ParticipationStats['sessions'][number];

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function isoToDateInput(iso: string): string {
  // YYYY-MM-DD slice from a full ISO string
  return iso.slice(0, 10);
}

/**
 * Themed recharts tooltip — mono mini-card built from theme tokens so the
 * chart matches the console vocabulary instead of recharts' default white
 * box. We render a small Card-like surface inline because the recharts
 * tooltip needs a synchronous component for each hovered point.
 */
function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ value?: number | string; name?: string }>;
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const value = payload[0]?.value ?? 0;
  return (
    <div
      style={{
        background: 'var(--color-surface-2)',
        border: '2px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-sm)',
        padding: '6px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        letterSpacing: '0.06em',
        color: 'var(--color-fg)',
      }}
    >
      <div style={{ color: 'var(--color-fg-muted)', fontSize: 10, letterSpacing: '0.12em' }}>
        {String(label ?? '')}
      </div>
      <div style={{ color: 'var(--color-primary)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {value} check-ins
      </div>
    </div>
  );
}

export function StatsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const isOfficer = user?.role === 'OFFICER' || isAdmin;
  const fromId = useId();
  const toId = useId();

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  // Build query string when the user has picked a custom range; otherwise use
  // the API default (~6 months back).
  const statsUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (fromDate) params.set('from', `${fromDate}T00:00:00.000Z`);
    if (toDate) params.set('to', `${toDate}T23:59:59.999Z`);
    const qs = params.toString();
    return qs ? `/stats/participation?${qs}` : '/stats/participation';
  }, [fromDate, toDate]);

  const { data: stats, refresh } = useAutoFetch<ParticipationStats>(statsUrl, {
    intervalMs: 15000,
  });
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SessionRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SessionRow | null>(null);
  // Which past net's log is open for editing, and which is having a missed
  // station added. One at a time: this page lists every session in range, and
  // arrows on all of them at once would be a wall of controls over a view
  // people mostly read.
  const [editingLogId, setEditingLogId] = useState<string | null>(null);
  const [addToSessionId, setAddToSessionId] = useState<string | null>(null);
  const logEditing = useLogEditing(editingLogId, refresh);
  // Delete failures render in-page: window.alert is unstyled, blocks the tab,
  // and is invisible in a kiosk browser — the same reason every other native
  // dialog in the app was replaced.
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [memberSort, setMemberSort] = useState<'count' | 'callsign' | 'name'>('count');

  function exportCsv() {
    const a = document.createElement('a');
    a.href = '/api/stats/export.csv';
    a.download = 'checkins.csv';
    a.click();
  }

  async function copySessionLog(s: SessionRow) {
    try {
      await navigator.clipboard.writeText(buildSessionLogText(s));
      setCopiedSessionId(s.id);
      window.setTimeout(() => setCopiedSessionId(null), 1500);
    } catch {
      /* ignore — older browsers */
    }
  }

  async function performDelete() {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    setConfirmDelete(null);
    setDeleteErr(null);
    try {
      await apiFetch(`/sessions/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setDeleteErr((e as Error).message);
    }
  }

  const sortedMembers = useMemo(() => {
    if (!stats) return [];
    const list = [...stats.perMember];
    if (memberSort === 'count') list.sort((a, b) => b.count - a.count);
    else if (memberSort === 'callsign')
      list.sort((a, b) => a.callsign.localeCompare(b.callsign));
    else list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [stats, memberSort]);

  const sortedNets = useMemo(() => {
    if (!stats) return [];
    return [...stats.perNet].sort((a, b) => b.checkIns - a.checkIns);
  }, [stats]);

  if (!stats) {
    return (
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        <header className="hna-page-header">
          <p className="hna-page-marker">// 06 — STATS</p>
          <h1 className="hna-page-title">Stats</h1>
          <p className="hna-page-sub">Participation across nets and members.</p>
        </header>
        <Card>
          <p className="hna-mono" style={{ margin: 0, color: 'var(--color-fg-muted)' }}>
            LOADING…
          </p>
        </Card>
      </div>
    );
  }

  const uniqueMembers = stats.perMember.length;

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <header className="hna-page-header">
        <p className="hna-page-marker">// 06 — STATS</p>
        <h1 className="hna-page-title">Stats</h1>
        <p className="hna-page-sub">Participation across nets and members.</p>
      </header>

      {/* Toolbar Card — range filter + export */}
      <Card>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 'var(--space-3)',
            alignItems: 'end',
          }}
        >
          <div className="hna-field">
            <label htmlFor={fromId}>From</label>
            <Input
              id={fromId}
              type="date"
              value={fromDate}
              max={toDate || today}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>
          <div className="hna-field">
            <label htmlFor={toId}>To</label>
            <Input
              id={toId}
              type="date"
              value={toDate}
              min={fromDate || undefined}
              max={today}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              alignItems: 'center',
            }}
          >
            <span
              className="hna-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.1em',
                color: 'var(--color-fg-muted)',
              }}
            >
              {isoToDateInput(stats.range.from)} → {isoToDateInput(stats.range.to)}
            </span>
            <Button onClick={exportCsv}>Export CSV</Button>
            {isOfficer && (
              <Button variant="ghost" onClick={() => void refresh()}>
                Refresh
              </Button>
            )}
          </div>
        </div>
      </Card>

      <SectionDivider>OVERVIEW</SectionDivider>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {/* Totals */}
        <Card>
          <p className="hna-cap hna-cap--accent">[ TOTALS ]</p>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr',
              gap: 'var(--space-3)',
              margin: 0,
            }}
          >
            <Stat label="Sessions" value={stats.totalSessions} />
            <Stat label="Check-ins" value={stats.totalCheckIns} />
            <Stat label="Unique members" value={uniqueMembers} />
          </dl>
        </Card>

        {/* Per member */}
        <Card>
          <p className="hna-cap hna-cap--accent">[ PER MEMBER ]</p>
          {sortedMembers.length === 0 ? (
            <p
              className="hna-mono"
              style={{ margin: 0, color: 'var(--color-fg-muted)', fontSize: 12 }}
            >
              No participation data yet.
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="hna-log-table" style={{ minWidth: 320 }}>
                <caption className="sr-only">
                  Check-in counts per member
                </caption>
                <thead>
                  <tr>
                    <SortHeader
                      label="Callsign"
                      active={memberSort === 'callsign'}
                      onClick={() => setMemberSort('callsign')}
                    />
                    <SortHeader
                      label="Name"
                      active={memberSort === 'name'}
                      onClick={() => setMemberSort('name')}
                    />
                    <SortHeader
                      label="Check-ins"
                      active={memberSort === 'count'}
                      onClick={() => setMemberSort('count')}
                      align="right"
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortedMembers.slice(0, 12).map((m) => (
                    <tr key={m.callsign}>
                      <th
                        scope="row"
                        className="hna-log-table__cs"
                        style={{ textAlign: 'left' }}
                      >
                        {displayCallsign(m.callsign)}
                      </th>
                      <td>{m.name}</td>
                      <td
                        className="hna-mono"
                        style={{
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          color: 'var(--color-fg)',
                          fontWeight: 700,
                        }}
                      >
                        {m.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Per net */}
        <Card>
          <p className="hna-cap hna-cap--accent">[ PER NET ]</p>
          {sortedNets.length === 0 ? (
            <p
              className="hna-mono"
              style={{ margin: 0, color: 'var(--color-fg-muted)', fontSize: 12 }}
            >
              No participation data yet.
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="hna-log-table" style={{ minWidth: 320 }}>
                <caption className="sr-only">
                  Sessions and average attendance per net
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Net</th>
                    <th
                      scope="col"
                      data-align="right"
                      style={{ textAlign: 'right' }}
                    >
                      Sessions
                    </th>
                    <th
                      scope="col"
                      data-align="right"
                      style={{ textAlign: 'right' }}
                    >
                      Avg attendance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedNets.map((n) => {
                    const avg =
                      n.sessions > 0 ? Math.round((n.checkIns / n.sessions) * 10) / 10 : 0;
                    return (
                      <tr key={n.netId}>
                        <th
                          scope="row"
                          className="hna-display"
                          style={{ fontSize: 13, color: 'var(--color-fg)', textAlign: 'left' }}
                        >
                          {n.netName}
                        </th>
                        <td
                          className="hna-mono"
                          style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                        >
                          {n.sessions}
                        </td>
                        <td
                          className="hna-mono"
                          style={{
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                            color: 'var(--color-primary)',
                            fontWeight: 700,
                          }}
                        >
                          {avg}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Chart */}
      <SectionDivider>CHECK-INS PER NET</SectionDivider>
      <Card>
        {sortedNets.length === 0 ? (
          <p
            className="hna-mono"
            style={{ margin: 0, color: 'var(--color-fg-muted)', fontSize: 12 }}
          >
            No participation data yet.
          </p>
        ) : (
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={sortedNets}>
                <CartesianGrid
                  strokeDasharray="2 4"
                  stroke="var(--color-border)"
                  vertical={false}
                />
                <XAxis
                  dataKey="netName"
                  tick={{
                    fill: 'var(--color-fg-muted)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                  }}
                  stroke="var(--color-border-strong)"
                />
                <YAxis
                  allowDecimals={false}
                  tick={{
                    fill: 'var(--color-fg-muted)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                  }}
                  stroke="var(--color-border-strong)"
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ fill: 'color-mix(in srgb, var(--color-primary) 8%, transparent)' }}
                />
                <Bar dataKey="checkIns" fill="var(--color-primary)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Sessions */}
      <SectionDivider>SESSIONS</SectionDivider>
      <div className="hna-stack">
        {stats.sessions.length === 0 && (
          <Card>
            <p
              className="hna-mono"
              style={{ margin: 0, color: 'var(--color-fg-muted)', fontSize: 12 }}
            >
              No sessions in range.
            </p>
          </Card>
        )}
        {stats.sessions.map((s) => (
          <Card key={s.id}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: 'var(--space-3)',
                alignItems: 'start',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                    gap: 'var(--space-3)',
                  }}
                >
                  <span
                    className="hna-mono"
                    style={{
                      fontSize: 12,
                      letterSpacing: '0.1em',
                      color: 'var(--color-fg-muted)',
                    }}
                  >
                    {formatDate(s.startedAt)}
                  </span>
                  <h3
                    className="hna-display"
                    style={{ margin: 0, fontSize: 18, fontWeight: 700, lineHeight: 1.1 }}
                  >
                    {s.netName}
                  </h3>
                  <span className="hna-chip">{s.checkIns.length} check-ins</span>
                </div>
                {s.topic && (
                  <p style={{ margin: '6px 0 0', fontSize: 14 }}>Topic: {s.topic}</p>
                )}
                {s.controlOp && (
                  <p
                    className="hna-mono"
                    style={{
                      margin: '4px 0 0',
                      fontSize: 12,
                      letterSpacing: '0.06em',
                      color: 'var(--color-fg-muted)',
                    }}
                  >
                    CONTROL ·{' '}
                    <span style={{ color: 'var(--color-primary)', fontWeight: 700 }}>
                      {displayCallsign(s.controlOp.callsign)}
                    </span>{' '}
                    · {s.controlOp.name}
                  </p>
                )}
                {(s.checkIns.length > 0 || isOfficer) && (
                  <details
                    className="hna-disclosure"
                    style={{ marginTop: 'var(--space-3)' }}
                  >
                    <summary>SHOW CHECK-INS ({s.checkIns.length})</summary>
                    {isOfficer && (
                      <div className="hna-log-edit-bar" style={{ marginTop: 8 }}>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setEditingLogId(editingLogId === s.id ? null : s.id);
                            logEditing.clearError();
                          }}
                          aria-pressed={editingLogId === s.id}
                          data-testid={`stats-edit-log-${s.id}`}
                        >
                          {editingLogId === s.id ? 'Done editing' : 'Edit log'}
                        </Button>
                        {editingLogId === s.id && (
                          <>
                            <Button
                              onClick={() => setAddToSessionId(s.id)}
                              data-testid={`stats-add-checkin-${s.id}`}
                            >
                              Add a missed station
                            </Button>
                            <p className="hna-mono hna-log-edit-bar__hint">
                              Check-in times stay as recorded — only the order
                              changes.
                            </p>
                          </>
                        )}
                      </div>
                    )}
                    {editingLogId === s.id && logEditing.error && (
                      <p
                        className="hna-input-error"
                        role="alert"
                        data-testid="stats-log-error"
                      >
                        {logEditing.error}
                      </p>
                    )}
                    <ol style={{ marginTop: 8, paddingLeft: 22 }}>
                      {s.checkIns.map((c, idx) => (
                        <li
                          key={c.id}
                          style={{ fontSize: 13, padding: '2px 0' }}
                        >
                          {editingLogId === s.id && (
                            <span className="hna-log-table__move">
                              <button
                                type="button"
                                className="hna-roster__move-btn"
                                onClick={() =>
                                  void logEditing.move(
                                    s.checkIns.map((x) => x.id),
                                    idx,
                                    -1,
                                  )
                                }
                                disabled={idx === 0 || logEditing.busy}
                                aria-label={`Move ${c.callsign} earlier`}
                                data-testid={`stats-move-up-${c.callsign}`}
                              >
                                ▲
                              </button>
                              <button
                                type="button"
                                className="hna-roster__move-btn"
                                onClick={() =>
                                  void logEditing.move(
                                    s.checkIns.map((x) => x.id),
                                    idx,
                                    1,
                                  )
                                }
                                disabled={
                                  idx === s.checkIns.length - 1 || logEditing.busy
                                }
                                aria-label={`Move ${c.callsign} later`}
                                data-testid={`stats-move-down-${c.callsign}`}
                              >
                                ▼
                              </button>
                            </span>
                          )}
                          <span
                            className="hna-mono"
                            style={{
                              color: 'var(--color-primary)',
                              fontWeight: 700,
                              marginRight: 6,
                            }}
                          >
                            {displayCallsign(c.callsign)}
                          </span>
                          {c.name}
                          {c.mode === 'echolink' && (
                            <span
                              className="hna-chip"
                              data-testid="echolink-chip"
                              style={{ marginLeft: 6 }}
                              aria-label="Checked in via EchoLink"
                            >
                              ECHOLINK
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                  alignItems: 'stretch',
                }}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void copySessionLog(s)}
                >
                  {copiedSessionId === s.id ? 'Copied ✓' : 'Copy log'}
                </Button>
                {isAdmin && (
                  <Button variant="secondary" size="sm" onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                )}
                {isAdmin && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmDelete(s)}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {deleteErr && (
        <p className="hna-input-error" role="alert" data-testid="stats-delete-error">
          Couldn&rsquo;t delete that session: {deleteErr}
        </p>
      )}

      <AddCheckInModal
        open={addToSessionId !== null}
        sessionId={addToSessionId ?? ''}
        onClose={() => setAddToSessionId(null)}
        onAdded={() => void refresh()}
      />
      <EditSessionModal
        open={editing !== null}
        session={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          void refresh();
        }}
      />
      <ConfirmModal
        open={confirmDelete !== null}
        title="Delete session"
        message={
          confirmDelete
            ? `Delete session "${confirmDelete.netName} — ${new Date(confirmDelete.startedAt).toLocaleDateString()}"? This soft-deletes the session and all its check-ins. An admin can restore it from the Recently deleted card on the Admin page.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={() => {
          void performDelete();
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="hna-summary-stat">
      <span className="hna-summary-stat__label">{label}</span>
      <span className="hna-summary-stat__value hna-summary-stat__value--accent">
        {value}
      </span>
    </div>
  );
}

function SortHeader({
  label,
  active,
  onClick,
  align = 'left',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      data-align={align === 'right' ? 'right' : undefined}
      style={{ textAlign: align }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        style={{
          background: 'transparent',
          border: 0,
          padding: 0,
          font: 'inherit',
          color: active ? 'var(--color-primary)' : 'var(--color-fg-muted)',
          cursor: 'pointer',
          letterSpacing: 'inherit',
          textTransform: 'inherit',
          fontFamily: 'inherit',
        }}
      >
        {label}
        {active ? ' ▾' : ''}
      </button>
    </th>
  );
}
