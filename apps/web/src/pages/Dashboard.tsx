import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Net, Repeater, NetSession } from '@hna/shared';
import { roleAtLeast } from '@hna/shared';
import { apiFetch, errorMessage } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { LiveDot } from '../components/ui/LiveDot.js';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { useAuth } from '../auth/AuthProvider.js';
import { dayName, nextOccurrence } from '../lib/time.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { displayCallsign } from '../lib/format.js';

interface NetWithRepeater extends Net {
  repeater: Repeater;
  links?: Array<{ id: string; repeaterId: string; repeater: Repeater }>;
}

interface ActiveSessionRow extends NetSession {
  net: { id: string; name: string; repeater: Repeater };
  controlOp?: { id: string; callsign: string; name: string | null } | null;
  topicTitle?: string | null;
  topic?: { id: string; title: string } | null;
}

/**
 * Mono countdown: T-DD:HH:MM:SS — reads as a calibrated radio clock.
 */
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
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="hna-mono hna-countdown" aria-label="Time until net">
      T-
      {days > 0 ? `${pad(days)}:` : ''}
      {pad(hours)}:{pad(minutes)}:{pad(seconds)}
    </span>
  );
}

/**
 * Short countdown for the UPCOMING list — e.g. `T-04:23:11`.
 */
function ShortCountdown({ target }: { target: Date }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const diff = Math.max(0, target.getTime() - now);
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="hna-mono" aria-label="Time until next occurrence">
      T-{days > 0 ? `${pad(days)}d ` : ''}
      {pad(hours)}:{pad(minutes)}
    </span>
  );
}

export function Dashboard() {
  const { user } = useAuth();
  const nav = useNavigate();
  const isAdmin = user?.role === 'ADMIN';
  // Run-the-net authority (take control, start a PREP session) — NET_CONTROL+.
  const canRunNet = !!user && roleAtLeast(user.role, 'NET_CONTROL');

  // One in-flight action at a time across the ACTIVE NOW rows: the id disables
  // that row's buttons (blocking the double-fire that produced the "click again"
  // loop) and any failure is surfaced instead of swallowed.
  const [busySessionId, setBusySessionId] = React.useState<string | null>(null);
  const [actionErr, setActionErr] = React.useState<string | null>(null);

  async function takeControl(sessionId: string) {
    if (busySessionId) return;
    setBusySessionId(sessionId);
    setActionErr(null);
    try {
      await apiFetch(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ controlOpId: user!.id }),
      });
      nav(`/run/${sessionId}`);
    } catch (e) {
      setActionErr(errorMessage(e));
      setBusySessionId(null);
    }
  }

  /** Run-the-net shortcut from the dashboard PREP row — transition PREP → LIVE
   *  without first having to open the run-net page. */
  async function startPrepSession(sessionId: string) {
    if (busySessionId) return;
    setBusySessionId(sessionId);
    setActionErr(null);
    try {
      await apiFetch(`/sessions/${sessionId}/start`, { method: 'POST' });
      await refreshActive();
    } catch (e) {
      setActionErr(errorMessage(e));
    } finally {
      setBusySessionId(null);
    }
  }
  const { data: netsData } = useAutoFetch<NetWithRepeater[]>('/nets', {
    intervalMs: 10000,
  });
  const { data: sessionsData, refresh: refreshSessions } = useAutoFetch<
    NetSession[]
  >('/sessions', { intervalMs: 10000 });
  const { data: activeSessionsData, refresh: refreshActive } = useAutoFetch<ActiveSessionRow[]>(
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

  const weeklyNets = nets.filter((n) => (n.kind ?? 'weekly') === 'weekly');
  const upcoming = [...weeklyNets]
    .map((n) => ({ n, when: nextOccurrence(n.dayOfWeek, n.startLocal, n.timezone) }))
    .sort((a, b) => a.when.getTime() - b.when.getTime())
    .slice(0, 3);

  const hero = upcoming[0];
  const followups = upcoming.slice(1);

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <header className="hna-page-header">
        <p className="hna-page-marker">// 01 — DASHBOARD</p>
        <h1 className="hna-page-title">Dashboard</h1>
        <p className="hna-page-sub">
          Quick view of the nets you operate or join.
        </p>
      </header>

      {/* ===== ACTIVE NOW ===== */}
      <section aria-labelledby="dash-active">
        <h2 id="dash-active" className="hna-cap hna-cap--accent">
          [ ACTIVE NOW ]
        </h2>
        {actionErr && (
          <p className="hna-input-error" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
            {actionErr}
          </p>
        )}
        {activeSessions.length === 0 ? (
          <Card>
            <div className="hna-empty">
              <p className="hna-empty__title">No nets are live.</p>
              <p className="hna-empty__body">
                When a control operator starts a session it will show up here
                in real time.
              </p>
            </div>
          </Card>
        ) : (
          <div className="hna-stack">
            {activeSessions.map((s) => {
              const op = s.controlOp;
              const isPrep = s.liveAt == null;
              return (
                <Card key={s.id}>
                  <div className="hna-net-row">
                    <div className="hna-net-row__when">
                      {isPrep ? (
                        <Link
                          to={`/run/${s.id}`}
                          className="hna-mono"
                          data-testid="dash-prep-chip"
                          title={`Open the prep console for ${s.net.name}`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 11,
                            letterSpacing: '0.14em',
                            textTransform: 'uppercase',
                            color: 'var(--color-warn, #d49016)',
                            textDecoration: 'underline',
                            textUnderlineOffset: 3,
                          }}
                        >
                          PREP
                        </Link>
                      ) : (
                        <span className="hna-live-label">
                          <LiveDot label="Live" /> &nbsp;LIVE
                        </span>
                      )}
                      <span className="hna-net-row__name">{s.net.name}</span>
                    </div>
                    <div className="hna-net-row__meta">
                      <span className="hna-net-row__freq">
                        {s.net.repeater.frequency.toFixed(3)} MHz
                      </span>
                      <span className="hna-net-row__sub">
                        {s.net.repeater.name}
                        {op ? (
                          <>
                            {' '}· NCS{' '}
                            <span className="hna-mono">
                              {displayCallsign(op.callsign)}
                            </span>
                          </>
                        ) : null}
                        {s.topicTitle || s.topic ? (
                          <> · {s.topicTitle ?? s.topic?.title}</>
                        ) : isPrep && s.autoOpened ? (
                          <>
                            {' '}·{' '}
                            <span
                              className="hna-mono"
                              data-testid={`dash-topic-not-set-${s.id}`}
                              style={{
                                fontSize: 11,
                                letterSpacing: '0.1em',
                                textTransform: 'uppercase',
                                color: 'var(--color-fg-muted)',
                              }}
                              title="This net auto-opened without a topic — pick one in prep."
                            >
                              Topic not set
                            </span>
                          </>
                        ) : null}
                      </span>
                    </div>
                    <div className="hna-net-row__actions">
                      {canRunNet && isPrep && (
                        <Button
                          variant="ghost"
                          data-testid={`dash-start-prep-${s.id}`}
                          disabled={busySessionId === s.id}
                          onClick={() => void startPrepSession(s.id)}
                        >
                          {busySessionId === s.id ? 'Starting…' : 'Start'}
                        </Button>
                      )}
                      {canRunNet && (
                        <>
                          <Button
                            variant="secondary"
                            aria-describedby={`dash-take-control-help-${s.id}`}
                            title="Transfer Net Control authority to yourself for this session."
                            disabled={busySessionId === s.id}
                            onClick={() => void takeControl(s.id)}
                          >
                            Take control
                          </Button>
                          {/* sr-only — keeps the explanation reachable
                           * for screen readers via aria-describedby
                           * without squeezing visible text into the
                           * action row. */}
                          <span
                            id={`dash-take-control-help-${s.id}`}
                            className="sr-only"
                          >
                            Transfer Net Control authority to yourself for this session.
                          </span>
                        </>
                      )}
                      <Link to={`/run/${s.id}`}>
                        <Button variant="primary">Open net</Button>
                      </Link>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <SectionDivider>UPCOMING</SectionDivider>

      {/* ===== UPCOMING ===== */}
      <section aria-labelledby="dash-upcoming">
        <h2 id="dash-upcoming" className="hna-cap">
          [ UPCOMING ]
        </h2>
        {hero ? (
          <Card>
            <div className="hna-net-row">
              <div className="hna-net-row__when">
                <span className="hna-net-row__schedule">
                  {dayName(hero.when.getDay()).toUpperCase()}{' '}
                  {hero.when.toLocaleString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })}
                </span>
                <span className="hna-net-row__name">{hero.n.name}</span>
              </div>
              <div className="hna-net-row__meta">
                <Countdown target={hero.when} />
                <span className="hna-net-row__sub">
                  <span className="hna-mono">
                    {hero.n.repeater.frequency.toFixed(3)} MHz
                  </span>{' '}
                  · {hero.n.repeater.name}
                </span>
              </div>
              <div className="hna-net-row__actions">
                <Link to={`/nets`}>
                  <Button variant="secondary">All nets</Button>
                </Link>
              </div>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="hna-empty">
              <p className="hna-empty__title">No weekly nets scheduled.</p>
              <p className="hna-empty__body">
                Once a club officer adds a weekly net, the next three
                occurrences will show up here with a live countdown.
              </p>
            </div>
          </Card>
        )}
        {followups.length > 0 && (
          <div className="hna-stack hna-stack--tight" style={{ marginTop: 16 }}>
            {followups.map(({ n, when }) => (
              <Card key={n.id}>
                <div className="hna-net-row">
                  <div className="hna-net-row__when">
                    <span className="hna-net-row__schedule">
                      {dayName(when.getDay()).toUpperCase()}{' '}
                      {when.toLocaleString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                      })}
                    </span>
                    <span className="hna-net-row__name">{n.name}</span>
                  </div>
                  <div className="hna-net-row__meta">
                    <ShortCountdown target={when} />
                    <span className="hna-net-row__sub">
                      <span className="hna-mono">
                        {n.repeater.frequency.toFixed(3)} MHz
                      </span>{' '}
                      · {n.repeater.name}
                      {n.links && n.links.length > 0
                        ? ` · +${n.links.length} linked`
                        : ''}
                    </span>
                  </div>
                  <div className="hna-net-row__actions">
                    <Link to={`/nets/${n.id}/join`}>
                      <Button variant="secondary">Join net</Button>
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <SectionDivider>RECENT</SectionDivider>

      {/* ===== RECENT ===== */}
      <section aria-labelledby="dash-recent">
        <h2 id="dash-recent" className="hna-cap">
          [ RECENT ]
        </h2>
        {sessions.length === 0 ? (
          <Card>
            <div className="hna-empty">
              <p className="hna-empty__title">No sessions logged yet.</p>
              <p className="hna-empty__body">
                Net sessions appear here after they end. The most recent five
                will be listed.
              </p>
            </div>
          </Card>
        ) : (
          <div className="hna-stack hna-stack--tight">
            {sessions.slice(0, 5).map((s) => (
              <Card key={s.id}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 16,
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div className="hna-mono" style={{ fontSize: 12, color: 'var(--color-fg-muted)' }}>
                      {new Date(s.startedAt)
                        .toLocaleString(undefined, {
                          month: 'short',
                          day: '2-digit',
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true,
                        })
                        .toUpperCase()}
                    </div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 14 }}>
                      {s.endedAt ? 'Ended' : 'In progress'}
                    </div>
                  </div>
                  {isAdmin && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => deleteSession(s.id)}
                      aria-label="Delete session"
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
