import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { ConfirmModal } from '../components/ui/ConfirmModal.js';
import { LiveDot } from '../components/ui/LiveDot.js';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { Input } from '../components/ui/Input.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { usePresence } from '../lib/usePresence.js';
import { OnlineDot } from '../components/OnlineDot.js';
import { useAuth } from '../auth/AuthProvider.js';
import {
  capitalizeFirst,
  displayCallsign,
} from '../lib/format.js';
import { looksLikeHtml } from '../lib/scriptFormat.js';
import { SanitizedHtml } from '../components/SanitizedHtml.js';
import { ChatBox } from '../components/ChatBox.js';
import { EditCheckInModal } from '../components/EditCheckInModal.js';
import { NetEditModal, netToInput } from '../components/NetEditModal.js';

interface NetLinkWithRepeater {
  id: string;
  repeaterId: string;
  repeater: Repeater;
  note?: string | null;
}
interface NetFull extends Net {
  repeater: Repeater;
  links?: NetLinkWithRepeater[];
}
interface SessionResponse extends NetSession {
  checkIns: CheckIn[];
  net?: NetFull;
  topicTitle?: string | null;
  topic?: { id: string; title: string } | null;
  controlOp?: { callsign: string; name: string } | null;
}
interface DirectoryEntry {
  callsign: string;
  name: string;
}
interface ControlCandidate {
  id: string;
  callsign: string;
  name: string;
  role: string;
}

const SCRIPT_CATEGORY_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  general: 'General',
  impromptu: 'Impromptu',
};

/** Elapsed `T+HH:MM:SS` mono counter that ticks every second. */
function ElapsedTimer({ startIso }: { startIso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const ms = Math.max(0, now - new Date(startIso).getTime());
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span
      className="hna-runnet-status__elapsed"
      aria-label="Elapsed time"
      title="Elapsed time"
    >
      T+{pad(h)}:{pad(m)}:{pad(s)}
    </span>
  );
}

export function RunNetPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const { data: session, refresh } = useAutoFetch<SessionResponse>(
    sessionId ? `/sessions/${sessionId}` : null,
    { intervalMs: 3000 },
  );
  const [net, setNet] = useState<NetFull | null>(null);
  const [callsign, setCallsign] = useState('');
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [endNotes, setEndNotes] = useState('');
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [editingCheckIn, setEditingCheckIn] = useState<CheckIn | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [controlOpen, setControlOpen] = useState(false);
  const [controlCandidates, setControlCandidates] = useState<ControlCandidate[]>([]);
  const [editNetOpen, setEditNetOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const canManageControl = user?.role === 'OFFICER' || user?.role === 'ADMIN';
  const { isOnlineByCallsign } = usePresence();
  const inputRef = useRef<HTMLInputElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const lastAutoFilledNameRef = useRef<string>('');
  const nameRef = useRef<string>('');
  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  // Derive net from session payload; fall back to /nets if the backend
  // didn't inline it (older responses).
  useEffect(() => {
    if (!session) return;
    if (session.net) {
      setNet(session.net);
      return;
    }
    const ctrl = new AbortController();
    apiFetch<NetFull[]>('/nets', { signal: ctrl.signal })
      .then((nets) => {
        setNet(nets.find((x) => x.id === session.netId) ?? null);
      })
      .catch((e) => {
        if (!isAbortError(e)) console.warn('net load failed', e);
      });
    return () => ctrl.abort();
  }, [session]);

  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<DirectoryEntry[]>('/users/directory', { signal: ctrl.signal })
      .then(setDirectory)
      .catch((e) => {
        if (!isAbortError(e)) console.warn('directory load failed', e);
      });
    return () => ctrl.abort();
  }, []);

  // Load the Net Control candidate roster when the reassign modal opens.
  useEffect(() => {
    if (!controlOpen || !canManageControl) return;
    const ctrl = new AbortController();
    apiFetch<ControlCandidate[]>('/users/control-candidates', { signal: ctrl.signal })
      .then(setControlCandidates)
      .catch((e) => {
        if (!isAbortError(e)) console.warn('control candidates load failed', e);
      });
    return () => ctrl.abort();
  }, [controlOpen, canManageControl]);

  // Dismiss the overflow menu when clicking outside it.
  useEffect(() => {
    if (!overflowOpen) return;
    function onDoc(e: MouseEvent) {
      if (
        overflowMenuRef.current &&
        e.target instanceof Node &&
        !overflowMenuRef.current.contains(e.target)
      ) {
        setOverflowOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [overflowOpen]);

  async function reassignControl(newControlOpId: string) {
    if (!sessionId) return;
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ controlOpId: newControlOpId }),
    });
    setControlOpen(false);
    await refresh();
  }

  // Autofill name from member directory (instant), check-in history + FCC lookup
  // (parallel, debounced) with history priority for repeat visitors.
  useEffect(() => {
    const cs = callsign.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,7}$/.test(cs)) return;

    const maybeSetName = (candidate: string) => {
      const current = nameRef.current;
      if (current === '' || current === lastAutoFilledNameRef.current) {
        setName(candidate);
        lastAutoFilledNameRef.current = candidate;
      }
    };

    // 1. Instant local directory match
    const member = directory.find((d) => d.callsign === cs);
    if (member) {
      maybeSetName(member.name);
      return;
    }

    // 2. Parallel remote lookup with short debounce
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const history = apiFetch<{ callsign: string; name: string | null }>(
        `/checkins/callsign-history/${cs}`,
        { signal: ctrl.signal },
      ).catch((e) => {
        if (!isAbortError(e)) {
          /* ignore */
        }
        return { callsign: cs, name: null };
      });
      const fcc = apiFetch<{ name: string | null; found: boolean }>(
        `/callsign-lookup/${cs}`,
        { signal: ctrl.signal },
      ).catch((e) => {
        if (!isAbortError(e)) {
          /* ignore */
        }
        return { name: null, found: false };
      });
      Promise.all([history, fcc]).then(([h, f]) => {
        // Priority: history wins, FCC fallback if history has no name
        const pick = h.name ?? f.name;
        if (pick) maybeSetName(pick);
      });
    }, 120);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [callsign, directory]);

  async function undoLast() {
    const last = session?.checkIns[0];
    if (!last) return;
    await apiFetch(`/checkins/${last.id}`, { method: 'DELETE' });
    await refresh();
  }

  const canModify = (ci: CheckIn): boolean => {
    if (user?.role === 'OFFICER' || user?.role === 'ADMIN') return true;
    const recent = Date.now() - new Date(ci.checkedInAt).getTime() < 5 * 60 * 1000;
    return ci.createdById === user?.id && recent;
  };

  /** Whether the visible *user* could ever modify this row (used for the
   *  disabled-with-tooltip pencil state after the 5-min window closes). */
  const ownsRow = (ci: CheckIn): boolean => ci.createdById === user?.id;

  async function performDelete(id: string) {
    try {
      await apiFetch(`/checkins/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      console.warn('delete failed', e);
    } finally {
      setConfirmDeleteId(null);
    }
  }

  function endNet() {
    if (!sessionId) return;
    setReviewOpen(true);
  }

  async function confirmEnd() {
    if (!sessionId) return;
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        endedAt: new Date().toISOString(),
        notes: endNotes.trim() || undefined,
      }),
    });
    nav(`/sessions/${sessionId}/summary`);
  }

  async function addCheckIn(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!sessionId) return;
    if (!/^[A-Z0-9]{3,7}$/.test(callsign)) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const capitalized = capitalizeFirst(trimmed);
    const trimmedComment = comment.trim();
    await apiFetch(`/sessions/${sessionId}/checkins`, {
      method: 'POST',
      body: JSON.stringify({
        callsign,
        nameAtCheckIn: capitalized,
        ...(trimmedComment ? { comment: trimmedComment } : {}),
      }),
    });
    setCallsign('');
    setName('');
    setComment('');
    lastAutoFilledNameRef.current = '';
    inputRef.current?.focus();
    await refresh();
  }

  // Escape key opens the end-net review modal (Modal handles its own Escape to close)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !reviewOpen) {
        endNet();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, reviewOpen]);

  function onCallsignKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Backspace' && callsign === '') {
      e.preventDefault();
      void undoLast();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // If callsign is valid but name is empty, jump to the name field instead
      // of silently no-op. This gives the user a clear next step.
      if (/^[A-Z0-9]{3,7}$/.test(callsign) && !name.trim()) {
        const nameInput = document.getElementById('checkin-name-input') as HTMLInputElement | null;
        nameInput?.focus();
        return;
      }
      void addCheckIn();
    }
  }

  if (!session || !net) return <div style={{ padding: 24 }}>Loading session…</div>;

  const suggestions =
    callsign.length > 0
      ? directory
          .filter((d) => d.callsign.includes(callsign.toUpperCase()))
          .slice(0, 8)
      : directory.slice(0, 8);

  const repeaterFreq = `${net.repeater.frequency.toFixed(3)} MHz`;
  const scriptCategoryLabel =
    SCRIPT_CATEGORY_LABELS[net.scriptCategory ?? 'general'] ?? 'General';
  // Reversed for display (newest first) — index counter shows the original
  // check-in order ("#01" is the first person to check in).
  const checkInsNewestFirst = session.checkIns;
  const totalCheckIns = session.checkIns.length;

  return (
    <div>
      {/* ===== Page header ===== */}
      <header className="hna-page-header">
        <p className="hna-page-marker">// 04 — RUNNING NET</p>
        <h1 className="hna-page-title">{net.name}</h1>
        <p className="hna-page-sub">
          Live operator console — check-ins, chat, and script for the current
          session.
        </p>
      </header>

      {/* ===== Status strip (sticky) ===== */}
      <div className="hna-runnet-status" role="region" aria-label="Net status">
        <div className="hna-runnet-status__facts">
          <span className="hna-runnet-status__name">{net.name}</span>
          {session.controlOp && (
            <span className="hna-runnet-status__cell" title="Net control operator">
              NCS{' '}
              <OnlineDot online={isOnlineByCallsign(session.controlOp.callsign)} />{' '}
              <strong>{displayCallsign(session.controlOp.callsign)}</strong>
            </span>
          )}
          <span className="hna-runnet-status__cell">
            <strong>{net.repeater.name}</strong>
            <span style={{ opacity: 0.7 }}>·</span>
            <strong>{repeaterFreq}</strong>
          </span>
          <ElapsedTimer startIso={session.startedAt} />
          <span className="hna-runnet-status__live">
            <LiveDot />
            <span>LIVE</span>
          </span>
        </div>
        <div className="hna-runnet-status__actions">
          {user && canManageControl && session.controlOpId !== user.id && !session.endedAt && (
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await apiFetch(`/sessions/${session.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ controlOpId: user.id }),
                });
                await refresh();
              }}
            >
              Take control
            </Button>
          )}
          {canManageControl && !session.endedAt && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setControlOpen(true)}
            >
              Change control
            </Button>
          )}
          {canManageControl && (
            <div className="hna-overflow" ref={overflowMenuRef}>
              <button
                type="button"
                className="hna-overflow__btn"
                aria-label="More actions"
                aria-haspopup="true"
                aria-expanded={overflowOpen}
                title="More actions"
                onClick={() => setOverflowOpen((v) => !v)}
              >
                ⋯
              </button>
              {overflowOpen && (
                <div className="hna-overflow__menu" role="menu">
                  <Button
                    variant="ghost"
                    size="sm"
                    role="menuitem"
                    onClick={() => {
                      setOverflowOpen(false);
                      setEditNetOpen(true);
                    }}
                  >
                    Edit net
                  </Button>
                </div>
              )}
            </div>
          )}
          {canManageControl && (
            <Button variant="danger" size="sm" onClick={endNet}>
              End net
            </Button>
          )}
        </div>
      </div>

      {/* ===== Two-column rack ===== */}
      <div className="hna-runnet-grid2">
        {/* ----- Left column: Roster ----- */}
        <div className="hna-runnet-grid2__col">
          <Card>
            <header className="hna-section-caption">
              <h2 className="hna-section-caption__title">
                <span className="hna-cap hna-cap--accent" style={{ margin: 0 }}>
                  [ ROSTER ]
                </span>
              </h2>
              <span
                className="hna-section-caption__count"
                aria-live="polite"
                aria-atomic="true"
              >
                [ {totalCheckIns} CHECKED IN ]
              </span>
            </header>

            <form className="hna-checkin-form" onSubmit={addCheckIn}>
              <div className="hna-checkin-form__row">
                <div className="hna-field">
                  <label htmlFor="checkin-callsign-input">Callsign</label>
                  <div onKeyDown={onCallsignKeyDown}>
                    <CallsignInput
                      ref={inputRef}
                      id="checkin-callsign-input"
                      value={callsign}
                      onChange={setCallsign}
                      autoFocus
                      list="callsign-directory"
                    />
                  </div>
                  <datalist id="callsign-directory">
                    {suggestions.map((d) => (
                      <option key={d.callsign} value={d.callsign}>
                        {d.name}
                      </option>
                    ))}
                  </datalist>
                </div>
                <div className="hna-field">
                  <label htmlFor="checkin-name-input">Name</label>
                  <Input
                    id="checkin-name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const commentInput = document.getElementById(
                          'checkin-comment-input',
                        ) as HTMLInputElement | null;
                        if (commentInput) commentInput.focus();
                        else void addCheckIn();
                      }
                    }}
                  />
                </div>
              </div>
              <div className="hna-field">
                <label htmlFor="checkin-comment-input">Comment (optional)</label>
                <Input
                  id="checkin-comment-input"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={500}
                  placeholder="e.g. mobile, short-time"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void addCheckIn();
                    }
                  }}
                />
              </div>
              <div className="hna-checkin-form__actions">
                <Button type="submit">Add</Button>
                <Button type="button" variant="secondary" onClick={undoLast}>
                  Undo
                </Button>
              </div>
            </form>

            <SectionDivider>LOG</SectionDivider>

            <ul
              className="hna-roster"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Check-in log"
            >
              {checkInsNewestFirst.length === 0 && (
                <li
                  className="hna-empty"
                  style={{ padding: 'var(--space-4) 0' }}
                >
                  <p className="hna-empty__title">No check-ins yet.</p>
                  <p className="hna-empty__body">
                    Enter a callsign above to log the first check-in.
                  </p>
                </li>
              )}
              {checkInsNewestFirst.map((ci, displayIdx) => {
                // displayIdx is newest-first; convert to 1-based original
                // check-in order ("#01" is first to check in).
                const ord = totalCheckIns - displayIdx;
                const recent =
                  Date.now() - new Date(ci.checkedInAt).getTime() < 5 * 60 * 1000;
                const canEdit = canModify(ci);
                const showDisabledHint = !canEdit && ownsRow(ci) && !recent;
                return (
                  <li
                    key={ci.id}
                    className="hna-roster__row"
                  >
                    <span className="hna-roster__idx">#{String(ord).padStart(2, '0')}</span>
                    <span className="hna-roster__cs">
                      <OnlineDot online={isOnlineByCallsign(ci.callsign)} />
                      {displayCallsign(ci.callsign)}
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
        </div>

        {/* ----- Right column: Chat + Script ----- */}
        <div className="hna-runnet-grid2__col">
          <ChatBox sessionId={session.id} />

          <Card>
            <header className="hna-section-caption">
              <h2
                className="hna-section-caption__title"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                <span className="hna-cap hna-cap--accent" style={{ margin: 0 }}>
                  [ SCRIPT ]
                </span>
                <span>Script</span>
                <span className="hna-chip">{scriptCategoryLabel}</span>
              </h2>
              {canManageControl && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditNetOpen(true)}
                >
                  Edit net
                </Button>
              )}
            </header>
            {looksLikeHtml(net?.scriptMd ?? '') ? (
              <SanitizedHtml
                className="hna-script-html hna-script-panel"
                html={net?.scriptMd ?? ''}
              />
            ) : (
              <pre
                className="hna-script-panel"
                style={{ whiteSpace: 'pre-wrap', margin: 0 }}
              >
                {net?.scriptMd ?? ''}
              </pre>
            )}
          </Card>
        </div>
      </div>

      {/* ===== End-of-net review modal ===== */}
      <Modal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title="Review before ending net"
      >
        <div style={{ marginBottom: 8 }}>
          <strong>{net.name}</strong> — {net.repeater.name}
          <div
            className="hna-mono"
            style={{ fontSize: 12, color: 'var(--color-fg-muted)', marginTop: 4 }}
          >
            {session.checkIns.length} CHECK-IN{session.checkIns.length === 1 ? '' : 'S'}
            {session.startedAt && (
              <>
                {' · '}
                {Math.max(
                  1,
                  Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000),
                )}{' '}
                MIN
              </>
            )}
          </div>
        </div>
        <ol
          style={{
            maxHeight: 320,
            overflowY: 'auto',
            margin: '8px 0',
            padding: '8px 12px 8px 28px',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            background: 'var(--color-bg)',
          }}
        >
          {[...session.checkIns]
            .sort(
              (a, b) =>
                new Date(a.checkedInAt).getTime() - new Date(b.checkedInAt).getTime(),
            )
            .map((ci) => (
              <li key={ci.id} style={{ padding: '2px 0' }}>
                <span className="hna-mono" style={{ color: 'var(--color-fg-muted)' }}>
                  {new Date(ci.checkedInAt).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })}
                </span>{' '}
                — <strong className="hna-mono" style={{ color: 'var(--color-primary)' }}>{displayCallsign(ci.callsign)}</strong> — {ci.nameAtCheckIn}
              </li>
            ))}
          {session.checkIns.length === 0 && (
            <li style={{ listStyle: 'none', color: 'var(--color-fg-muted)' }}>
              No check-ins yet.
            </li>
          )}
        </ol>
        {notesExpanded ? (
          <div className="hna-field" style={{ marginTop: 8 }}>
            <label htmlFor="end-net-notes">Session notes (optional)</label>
            <textarea
              id="end-net-notes"
              className="hna-input"
              value={endNotes}
              onChange={(e) => setEndNotes(e.target.value)}
              style={{ width: '100%', minHeight: 80, marginTop: 4 }}
              autoFocus
            />
          </div>
        ) : (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setNotesExpanded(true)}
            style={{ marginTop: 8 }}
          >
            Add notes
          </Button>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 16,
          }}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => setReviewOpen(false)}
          >
            Keep running
          </Button>
          <Button type="button" variant="danger" onClick={confirmEnd}>
            End net
          </Button>
        </div>
      </Modal>

      <EditCheckInModal
        open={editingCheckIn !== null}
        checkIn={editingCheckIn}
        onClose={() => setEditingCheckIn(null)}
        onSaved={refresh}
      />
      {editNetOpen && (
        <NetEditModal
          open
          netId={net.id}
          initial={netToInput(net)}
          onClose={() => setEditNetOpen(false)}
          onSaved={refresh}
        />
      )}

      {/* Change control modal */}
      <Modal
        open={controlOpen}
        onClose={() => setControlOpen(false)}
        title="Change Net Control"
      >
        <p
          style={{
            fontSize: 13,
            color: 'var(--color-fg-muted)',
            marginTop: 0,
          }}
        >
          Reassign the control operator for this active net.
        </p>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '8px 0',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {controlCandidates.map((c) => (
            <li
              key={c.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                padding: '8px 0',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <span>
                <strong className="hna-mono" style={{ color: 'var(--color-primary)' }}>
                  {displayCallsign(c.callsign)}
                </strong>{' '}
                — {c.name}
                {session.controlOpId === c.id && (
                  <span
                    className="hna-mono"
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      color: 'var(--color-success)',
                      letterSpacing: '0.12em',
                      textTransform: 'uppercase',
                    }}
                  >
                    current
                  </span>
                )}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={session.controlOpId === c.id}
                onClick={() => reassignControl(c.id)}
              >
                Assign
              </Button>
            </li>
          ))}
          {controlCandidates.length === 0 && (
            <li style={{ color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
              No eligible operators found.
            </li>
          )}
        </ul>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <Button variant="secondary" onClick={() => setControlOpen(false)}>
            Close
          </Button>
        </div>
      </Modal>

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
