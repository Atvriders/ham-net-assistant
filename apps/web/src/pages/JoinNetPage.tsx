import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { ConfirmModal } from '../components/ui/ConfirmModal.js';
import { LiveDot } from '../components/ui/LiveDot.js';
import { OnlineDot } from '../components/OnlineDot.js';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { Input } from '../components/ui/Input.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { usePresence } from '../lib/usePresence.js';
import {
  capitalizeFirst,
  displayCallsign,
} from '../lib/format.js';
import { looksLikeHtml } from '../lib/scriptFormat.js';
import { SanitizedHtml } from '../components/SanitizedHtml.js';
import { ChatBox } from '../components/ChatBox.js';
import { EditCheckInModal } from '../components/EditCheckInModal.js';

interface NetFull extends Net {
  repeater: Repeater;
  links?: Array<{ id: string; repeaterId: string; repeater: Repeater }>;
}
interface ActiveSessionResponse extends NetSession {
  checkIns: CheckIn[];
  net?: NetFull;
  topicTitle?: string | null;
  topic?: { id: string; title: string } | null;
  controlOp?: { callsign: string; name: string } | null;
}

export function JoinNetPage() {
  const { netId } = useParams<{ netId: string }>();
  const { user } = useAuth();
  const { isOnlineByCallsign } = usePresence();
  const {
    data: session,
    loading,
    error,
    refresh,
  } = useAutoFetch<ActiveSessionResponse>(
    netId ? `/nets/${netId}/active-session` : null,
    { intervalMs: 5000 },
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [checkedInAt, setCheckedInAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editingCheckIn, setEditingCheckIn] = useState<CheckIn | null>(null);
  const [comment, setComment] = useState('');
  // Participation method — defaults to local RF, resets to RF after submit.
  const [mode, setMode] = useState<'rf' | 'echolink'>('rf');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const canModify = (ci: CheckIn): boolean => {
    if (user?.role === 'OFFICER' || user?.role === 'ADMIN') return true;
    const recent = Date.now() - new Date(ci.checkedInAt).getTime() < 5 * 60 * 1000;
    return ci.createdById === user?.id && recent;
  };
  const ownsRow = (ci: CheckIn): boolean => ci.createdById === user?.id;

  async function performDelete(id: string) {
    try {
      await apiFetch(`/checkins/${id}`, { method: 'DELETE' });
      setCheckedInAt(null);
      await refresh();
    } catch (e) {
      console.warn('delete failed', e);
    } finally {
      setConfirmDeleteId(null);
    }
  }

  // When the polled session first arrives, lock the button if we're
  // already on the list.
  useEffect(() => {
    if (!session || !user) return;
    const mine = session.checkIns.find((c) => c.callsign === user.callsign);
    if (mine) setCheckedInAt((prev) => prev ?? mine.checkedInAt);
  }, [session, user]);

  async function checkMeIn() {
    if (!session || !user) return;
    setSubmitting(true);
    setErrMsg(null);
    try {
      const capitalizedName = user.name ? capitalizeFirst(user.name) : '';
      const trimmedComment = comment.trim();
      await apiFetch(`/sessions/${session.id}/checkins`, {
        method: 'POST',
        body: JSON.stringify({
          callsign: user.callsign,
          nameAtCheckIn: capitalizedName,
          ...(trimmedComment ? { comment: trimmedComment } : {}),
          mode,
        }),
      });
      setCheckedInAt(new Date().toISOString());
      setComment('');
      setMode('rf');
      await refresh();
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !session) {
    return <div style={{ padding: 24 }}>Loading…</div>;
  }
  // Distinguish "no active net" (404 -> treated as null by fetch error path)
  // from real errors. The hook surfaces 404 as an error; we show the "no
  // running net" card for that specific case.
  const is404 =
    error !== null && /\b(not found|no active)/i.test(error);
  if (error && !is404) {
    return (
      <div style={{ padding: 24, color: 'var(--color-danger)' }} role="alert">
        {error}
      </div>
    );
  }

  // No active session view — empty state with next-occurrence hint when available.
  if (!session || is404) {
    return (
      <div>
        <header className="hna-page-header">
          <p className="hna-page-marker">// 02 — JOIN NET</p>
          <h1 className="hna-page-title">Join net</h1>
          <p className="hna-page-sub">Check in to the current session.</p>
        </header>
        <SectionDivider>NO SESSION</SectionDivider>
        <Card>
          <div className="hna-empty">
            <p className="hna-empty__title">No session running.</p>
            <p className="hna-empty__body">
              The control op will start the net at its scheduled time. Watch
              the dashboard for upcoming and live nets.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  const net = session.net;
  const topic = session.topicTitle ?? session.topic?.title ?? null;
  const repeaterFreq = net?.repeater
    ? `${net.repeater.frequency.toFixed(3)} MHz`
    : null;
  const myRow = user
    ? session.checkIns.find((c) => c.callsign === user.callsign)
    : null;
  const alreadyCheckedIn = Boolean(checkedInAt || myRow);
  const canStillEditOwn =
    !!myRow &&
    Date.now() - new Date(myRow.checkedInAt).getTime() < 5 * 60 * 1000;
  // PREP vs LIVE — members get a "preparing" card instead of the check-in form
  // until the control op presses START NET.
  const isPrep = session.liveAt == null;

  return (
    <div>
      <header className="hna-page-header">
        <p className="hna-page-marker">// 02 — JOIN NET</p>
        <h1 className="hna-page-title">Join net</h1>
        <p className="hna-page-sub">Check in to the current session.</p>
      </header>

      {/* ===== Net summary card ===== */}
      <Card>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-3) var(--space-5)',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'grid', gap: 4 }}>
            <span
              className="hna-net-row__name"
              style={{ fontSize: 24, lineHeight: 1 }}
            >
              {net?.name ?? 'Net in progress'}
            </span>
            {topic && (
              <span
                className="hna-mono"
                style={{
                  fontSize: 12,
                  color: 'var(--color-fg-muted)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                }}
              >
                TOPIC · {topic}
              </span>
            )}
          </div>
          {isPrep ? (
            <span
              className="hna-chip hna-chip--prep"
              data-testid="join-prep-chip"
              style={{
                background: 'var(--color-warn-bg, rgba(255,176,32,0.15))',
                color: 'var(--color-warn, #d49016)',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
              }}
            >
              PREP
            </span>
          ) : (
            <span className="hna-runnet-status__live">
              <LiveDot />
              <span>LIVE</span>
            </span>
          )}
        </div>
        {net?.repeater && (
          <div
            style={{
              marginTop: 'var(--space-4)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-3) var(--space-5)',
            }}
          >
            <span className="hna-runnet-status__cell">
              <strong>{net.repeater.name}</strong>
              <span style={{ opacity: 0.7 }}>·</span>
              <strong>{repeaterFreq}</strong>
            </span>
            {session.controlOp && (
              <span className="hna-runnet-status__cell" title="Net control operator">
                NCS{' '}
                <OnlineDot
                  online={isOnlineByCallsign(session.controlOp.callsign)}
                />{' '}
                <strong>{displayCallsign(session.controlOp.callsign)}</strong>
              </span>
            )}
            <span className="hna-runnet-status__cell">
              <span>CHECK-INS</span>
              <strong>{session.checkIns.length}</strong>
            </span>
          </div>
        )}
      </Card>

      {/* ===== Check-in form ===== */}
      <SectionDivider>YOU</SectionDivider>
      <Card>
        {isPrep ? (
          <div className="hna-empty" data-testid="join-preparing-card">
            <p className="hna-empty__title">
              PREPARING — {net?.name ?? 'Net'} is being set up.
            </p>
            <p className="hna-empty__body">
              Check back in a few minutes. The control op will start the net
              when they&rsquo;re ready; check-ins open at that point.
            </p>
          </div>
        ) : alreadyCheckedIn ? (
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <span className="hna-checkedin">
              ✓ YOU'RE CHECKED IN
              {checkedInAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {new Date(checkedInAt).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true,
                    })}
                  </span>
                </>
              )}
            </span>
            {myRow && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontFamily: 'var(--font-sans)',
                  fontSize: 14,
                }}
              >
                <strong
                  className="hna-mono"
                  style={{ color: 'var(--color-primary)' }}
                >
                  {displayCallsign(myRow.callsign)}
                </strong>
                <span>— {myRow.nameAtCheckIn}</span>
                {myRow.comment && (
                  <span style={{ color: 'var(--color-fg-muted)' }}>
                    · {myRow.comment}
                  </span>
                )}
                {canStillEditOwn && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditingCheckIn(myRow)}
                    style={{ marginLeft: 'auto' }}
                  >
                    Edit
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <div
              className="hna-field"
              role="group"
              aria-label="Participation method"
            >
              <span
                className="hna-mono"
                style={{
                  fontSize: 11,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--color-fg-muted)',
                }}
              >
                Mode
              </span>
              <div
                className="hna-mode-toggle"
                style={{ display: 'inline-flex', gap: 4, marginTop: 4 }}
                data-testid="join-mode-toggle"
              >
                <button
                  type="button"
                  className={
                    mode === 'rf'
                      ? 'hna-chip hna-chip--accent'
                      : 'hna-chip hna-chip--off'
                  }
                  style={{ cursor: 'pointer' }}
                  aria-pressed={mode === 'rf'}
                  onClick={() => setMode('rf')}
                  data-testid="join-mode-rf"
                >
                  [ RF ]
                </button>
                <button
                  type="button"
                  className={
                    mode === 'echolink'
                      ? 'hna-chip hna-chip--accent'
                      : 'hna-chip hna-chip--off'
                  }
                  style={{ cursor: 'pointer' }}
                  aria-pressed={mode === 'echolink'}
                  onClick={() => setMode('echolink')}
                  data-testid="join-mode-echolink"
                >
                  [ ECHOLINK ]
                </button>
              </div>
            </div>
            <div className="hna-field">
              <label htmlFor="join-comment-input">Comment (optional)</label>
              <Input
                id="join-comment-input"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={500}
                placeholder="e.g. mobile, short-time"
              />
            </div>
            <Button onClick={checkMeIn} disabled={submitting || !user}>
              {submitting ? 'Checking in…' : 'Check in'}
            </Button>
            {errMsg && (
              <div className="hna-input-error" role="alert">
                {errMsg}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ===== Script ===== */}
      {session.net?.scriptMd && (
        <>
          <SectionDivider>SCRIPT</SectionDivider>
          <Card>
            <h3
              className="hna-section-caption__title"
              style={{ marginTop: 0 }}
            >
              <span className="hna-cap hna-cap--accent" style={{ margin: 0 }}>
                [ SCRIPT ]
              </span>
            </h3>
            {looksLikeHtml(session.net.scriptMd) ? (
              <SanitizedHtml
                className="hna-script-html hna-script-panel"
                html={session.net.scriptMd}
              />
            ) : (
              <pre
                className="hna-script-panel"
                style={{ whiteSpace: 'pre-wrap', margin: 0 }}
              >
                {session.net.scriptMd}
              </pre>
            )}
          </Card>
        </>
      )}

      {/* ===== Roster ===== */}
      <SectionDivider>ROSTER</SectionDivider>
      <Card>
        <header className="hna-section-caption">
          <h3 className="hna-section-caption__title">
            <span className="hna-cap hna-cap--accent" style={{ margin: 0 }}>
              [ ROSTER ]
            </span>
          </h3>
          <span className="hna-section-caption__count">
            [ {session.checkIns.length} CHECKED IN ]
          </span>
        </header>
        <ul
          className="hna-roster"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Check-in log"
        >
          {session.checkIns.length === 0 && (
            <li
              className="hna-empty"
              style={{ padding: 'var(--space-4) 0' }}
            >
              <p className="hna-empty__title">No check-ins yet.</p>
              <p className="hna-empty__body">Be the first — check in above.</p>
            </li>
          )}
          {session.checkIns.map((ci, displayIdx) => {
            const ord = session.checkIns.length - displayIdx;
            const recent =
              Date.now() - new Date(ci.checkedInAt).getTime() < 5 * 60 * 1000;
            const canEdit = canModify(ci);
            const showDisabledHint = !canEdit && ownsRow(ci) && !recent;
            return (
              <li key={ci.id} className="hna-roster__row">
                <span className="hna-roster__idx">
                  #{String(ord).padStart(2, '0')}
                </span>
                <span className="hna-roster__cs">
                  <OnlineDot online={isOnlineByCallsign(ci.callsign)} />
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
                </span>
                <span className="hna-roster__name">
                  {ci.nameAtCheckIn}
                  {ci.comment && <small>{ci.comment}</small>}
                </span>
                <span className="hna-roster__time">
                  {new Date(ci.checkedInAt).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })}
                </span>
                <span className="hna-roster__actions">
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
                    onClick={() => canEdit && setConfirmDeleteId(ci.id)}
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
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* ===== Chat ===== */}
      <SectionDivider>CHAT</SectionDivider>
      <ChatBox sessionId={session.id} liveAt={session.liveAt ?? null} />

      <EditCheckInModal
        open={editingCheckIn !== null}
        checkIn={editingCheckIn}
        onClose={() => setEditingCheckIn(null)}
        onSaved={refresh}
      />
      <ConfirmModal
        open={confirmDeleteId !== null}
        title="Delete check-in"
        message="Delete this check-in?"
        confirmLabel="Delete"
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) void performDelete(confirmDeleteId);
        }}
      />
    </div>
  );
}
