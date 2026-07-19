import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { roleAtLeast } from '@hna/shared';
import { apiFetch, isAbortError, ApiErrorException } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { ConfirmModal } from '../components/ui/ConfirmModal.js';
import { LiveDot } from '../components/ui/LiveDot.js';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { Input } from '../components/ui/Input.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { useAsyncAction } from '../lib/useAsyncAction.js';
import { usePresence } from '../lib/usePresence.js';
import { OnlineDot } from '../components/OnlineDot.js';
import { useAuth } from '../auth/AuthProvider.js';
import {
  capitalizeFirst,
  displayCallsign,
} from '../lib/format.js';
import { scriptToHtml } from '../lib/scriptFormat.js';
import { SanitizedHtml } from '../components/SanitizedHtml.js';
import { ChatBox } from '../components/ChatBox.js';
import { FiveMinuteAnnouncement } from '../components/FiveMinuteAnnouncement.js';
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
interface RecommendedTopic {
  id: string;
  title: string;
  status: string;
  createdByCallsign?: string;
  recommended?: boolean;
}

const SCRIPT_CATEGORY_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  general: 'General',
  impromptu: 'Impromptu',
};

/** Format a mutation error into a console-appropriate message. */
function topicErrorMessage(e: unknown): string {
  return e instanceof ApiErrorException
    ? e.payload.message
    : (e as Error)?.message || 'Topic update failed';
}

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
  // Participation method for the next check-in. Defaults to 'rf' (the common
  // case on local repeater RF) and resets after each submit so the next
  // operator entry doesn't accidentally carry over an EchoLink flag.
  const [mode, setMode] = useState<'rf' | 'echolink'>('rf');
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
  // Prep-view topic picker: the OPEN suggestion queue (oldest-first, the oldest
  // flagged recommended) and the free-text custom-topic field. Only loaded/used
  // during PREP — once the net is LIVE the topic is shown read-only.
  const [recommendedTopics, setRecommendedTopics] = useState<RecommendedTopic[]>([]);
  const [customTopic, setCustomTopic] = useState('');
  const [topicBusy, setTopicBusy] = useState(false);
  const [topicErr, setTopicErr] = useState<string | null>(null);
  const [topicQueueNonce, setTopicQueueNonce] = useState(0);
  // Live-net topic editor toggle. Once the net is LIVE the topic collapses to a
  // compact read-only line with an Edit/Add button; opening it reveals the same
  // picker inline so an officer can change the topic mid-net without cluttering
  // the running console. Unused/irrelevant in PREP (the picker is always shown).
  const [liveTopicEditorOpen, setLiveTopicEditorOpen] = useState(false);
  // Two distinct gates:
  //   canRunNet   — run-the-net authority (take/change control, start/end the
  //                 session, edit/delete check-ins, set the net topic). Granted
  //                 to NET_CONTROL and up.
  //   canManageNet — club-config authority (editing the net itself via
  //                 NetEditModal). OFFICER and up only. A Net Control operator
  //                 can run a live net but must NOT touch net configuration.
  const canRunNet = !!user && roleAtLeast(user.role, 'NET_CONTROL');
  const canManageNet = !!user && roleAtLeast(user.role, 'OFFICER');
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
    if (!controlOpen || !canRunNet) return;
    const ctrl = new AbortController();
    apiFetch<ControlCandidate[]>('/users/control-candidates', { signal: ctrl.signal })
      .then(setControlCandidates)
      .catch((e) => {
        if (!isAbortError(e)) console.warn('control candidates load failed', e);
      });
    return () => ctrl.abort();
  }, [controlOpen, canRunNet]);

  // Load the OPEN topic-suggestion queue for the topic picker. Fetched while an
  // officer can pick from the queue: always in PREP, and in LIVE only while the
  // live topic editor is actually open (a fetch-on-open, not a poll — the effect
  // re-runs when the editor toggles or a suggestion is consumed, never on a
  // timer, so we don't hammer the endpoint while the live console runs with the
  // editor closed). `topicQueueNonce` forces a re-fetch after a suggestion is
  // consumed (marked USED).
  const sessionIsPrep = session?.liveAt == null;
  const topicQueueActive =
    canRunNet && (sessionIsPrep || liveTopicEditorOpen);
  useEffect(() => {
    if (!topicQueueActive) {
      setRecommendedTopics([]);
      return;
    }
    const ctrl = new AbortController();
    apiFetch<RecommendedTopic[]>('/topics/recommended', { signal: ctrl.signal })
      .then(setRecommendedTopics)
      .catch((e) => {
        if (!isAbortError(e)) console.warn('recommended topics load failed', e);
      });
    return () => ctrl.abort();
  }, [topicQueueActive, topicQueueNonce]);

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

  const reassignAction = useAsyncAction(async (newControlOpId: string) => {
    if (!sessionId) return;
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ controlOpId: newControlOpId }),
    });
    setControlOpen(false);
    await refresh();
  });

  // Prep-view topic actions. All three PATCH the session and then refresh so the
  // chosen topic shows immediately. Picking a queued suggestion also marks that
  // suggestion USED (mirrors the open-time flow in StartNetModal/session-create)
  // so it drains out of everyone's queue.
  async function applySuggestion(s: RecommendedTopic) {
    if (!sessionId || topicBusy) return;
    setTopicBusy(true);
    setTopicErr(null);
    try {
      await apiFetch(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ topicTitle: s.title, topicId: s.id }),
      });
      await apiFetch(`/topics/${s.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'USED' }),
      });
      setTopicQueueNonce((n) => n + 1);
      // Collapse the live editor back to the compact display after a change.
      // No-op in PREP where the picker is always shown.
      setLiveTopicEditorOpen(false);
    } catch (e) {
      setTopicErr(topicErrorMessage(e));
    } finally {
      // Reconcile the UI whether the change applied or failed (a partial
      // failure — session set but suggestion not drained — still needs a
      // re-fetch so the queue matches the server).
      setTopicBusy(false);
      await refresh();
    }
  }

  async function setCustomTopicTitle() {
    if (!sessionId || topicBusy) return;
    const trimmed = customTopic.trim();
    if (!trimmed) return;
    setTopicBusy(true);
    setTopicErr(null);
    try {
      // Custom/free-text topic — title only, no topicId (clears any prior link).
      await apiFetch(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ topicTitle: trimmed }),
      });
      setCustomTopic('');
      setLiveTopicEditorOpen(false);
    } catch (e) {
      setTopicErr(topicErrorMessage(e));
    } finally {
      setTopicBusy(false);
      await refresh();
    }
  }

  async function clearTopic() {
    if (!sessionId || topicBusy) return;
    setTopicBusy(true);
    setTopicErr(null);
    try {
      // Empty topicTitle clears both the title and the link server-side.
      await apiFetch(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ topicTitle: '' }),
      });
      setLiveTopicEditorOpen(false);
    } catch (e) {
      setTopicErr(topicErrorMessage(e));
    } finally {
      setTopicBusy(false);
      await refresh();
    }
  }

  // Transition PREP → LIVE. The API gates this to OFFICER+ and 409s if the
  // session is already live or already ended; the caller is responsible for
  // hiding the button in those states, but we still surface the error if it
  // races with another operator pressing START at the same time.
  const [startErr, setStartErr] = useState<string | null>(null);
  const [startingNet, setStartingNet] = useState(false);
  async function startNet() {
    if (!sessionId) return;
    setStartingNet(true);
    setStartErr(null);
    try {
      await apiFetch(`/sessions/${sessionId}/start`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setStartErr((e as Error).message);
    } finally {
      setStartingNet(false);
    }
  }

  // Take Net Control authority for this session (status-strip inline button).
  // Guarded + error-surfacing so a failed/slow PATCH can't silently no-op and
  // invite a double-click.
  const takeControlAction = useAsyncAction(async () => {
    if (!user || !session) return;
    await apiFetch(`/sessions/${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ controlOpId: user.id }),
    });
    await refresh();
  });

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

  // Undo the most recent check-in. Captures the target id inside the action so
  // a slow refresh can't shift `checkIns[0]` under a rapid second press.
  const undoLastAction = useAsyncAction(async () => {
    const last = session?.checkIns[0];
    if (!last) return;
    await apiFetch(`/checkins/${last.id}`, { method: 'DELETE' });
    await refresh();
  });

  const canModify = (ci: CheckIn): boolean => {
    if (canRunNet) return true;
    const recent = Date.now() - new Date(ci.checkedInAt).getTime() < 5 * 60 * 1000;
    return ci.createdById === user?.id && recent;
  };

  /** Whether the visible *user* could ever modify this row (used for the
   *  disabled-with-tooltip pencil state after the 5-min window closes). */
  const ownsRow = (ci: CheckIn): boolean => ci.createdById === user?.id;

  // Delete a check-in (confirm-modal action). On success the modal closes; on
  // failure it stays open with the error surfaced in the modal body. The
  // in-flight guard blocks a double-fire even though ConfirmModal's button
  // can't be disabled (its prop API is intentionally frozen).
  const deleteCheckInAction = useAsyncAction(async (id: string) => {
    await apiFetch(`/checkins/${id}`, { method: 'DELETE' });
    setConfirmDeleteId(null);
    await refresh();
  });

  const endNetAction = useAsyncAction(async () => {
    if (!sessionId) return;
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        endedAt: new Date().toISOString(),
        notes: endNotes.trim() || undefined,
      }),
    });
    // Close the review modal, then navigate — success is reflected exactly once
    // and only after the PATCH resolves.
    setReviewOpen(false);
    nav(`/sessions/${sessionId}/summary`);
  });

  function endNet() {
    if (!sessionId) return;
    // Clear any stale error from a previous attempt before re-opening.
    endNetAction.reset();
    setReviewOpen(true);
  }

  // Log a check-in. Guarded (disables Add + blocks re-entry so a fast
  // click+Enter can't log the same operator twice) and error-surfacing.
  const addCheckInAction = useAsyncAction(async () => {
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
        mode,
      }),
    });
    setCallsign('');
    setName('');
    setComment('');
    // Reset participation method so the next check-in starts from the common
    // RF default — keeps the operator from accidentally tagging a string of
    // RF check-ins as EchoLink after one VoIP entry.
    setMode('rf');
    lastAutoFilledNameRef.current = '';
    inputRef.current?.focus();
    await refresh();
  });

  // Note: a previous build wired a global Escape listener to open the
  // end-net review modal. That collided with Modal's own Escape-to-close,
  // so an Escape pressed inside any nested modal would close the modal AND
  // immediately open this review modal — a documented footgun per the
  // accessibility audit. Removed entirely; the "End net" button remains.

  function onCallsignKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Backspace' && callsign === '') {
      e.preventDefault();
      void undoLastAction.run();
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
      void addCheckInAction.run();
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
  // PREP vs LIVE state: liveAt is null while opened-but-not-started. Once set
  // (via POST /sessions/:id/start) the row is live and check-ins are accepted.
  const isPrep = session.liveAt == null;
  const liveStartIso = session.liveAt ?? session.startedAt;
  // Topic shown in both the prep picker (as "current") and the live read-only
  // line. topicTitle is the source of truth; fall back to the linked relation.
  const currentTopic = session.topicTitle ?? session.topic?.title ?? null;

  return (
    // hna-runnet-page widens the shell's content column for this page only
    // (see the `.hna-shell__main:has(.hna-runnet-page)` rule in ui.css) —
    // the live console uses most of the viewport instead of the 1280px cap.
    <div className="hna-runnet-page">
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
          {isPrep ? (
            <span
              className="hna-mono"
              data-testid="prep-not-started-label"
              style={{
                fontSize: 12,
                letterSpacing: '0.12em',
                color: 'var(--color-fg-muted)',
                textTransform: 'uppercase',
              }}
              aria-label="Not yet started — press start"
            >
              NOT YET STARTED — PRESS START
            </span>
          ) : (
            <ElapsedTimer startIso={liveStartIso} />
          )}
          {isPrep ? (
            <span
              className="hna-chip hna-chip--prep"
              data-testid="prep-chip"
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
        <div className="hna-runnet-status__actions">
          {isPrep && canRunNet && !session.endedAt && (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={startNet}
                disabled={startingNet}
                data-testid="start-net-button"
              >
                {startingNet ? 'Starting…' : 'START NET'}
              </Button>
              {startErr && (
                <span
                  className="hna-input-error"
                  role="alert"
                  style={{ fontSize: 11 }}
                >
                  {startErr}
                </span>
              )}
            </>
          )}
          {user && canRunNet && session.controlOpId !== user.id && !session.endedAt && (
            <>
              <Button
                variant="secondary"
                size="sm"
                aria-describedby="run-take-control-help"
                title="Transfer Net Control authority to yourself for this session."
                disabled={takeControlAction.pending}
                onClick={() => void takeControlAction.run()}
              >
                {takeControlAction.pending ? 'Taking…' : 'Take control'}
              </Button>
              {/* Accessibility caption — read by screen readers via
               * aria-describedby but rendered visually hidden so it
               * doesn't squeeze between the LIVE pill and the END NET
               * button (the layout bug the user reported). The hover
               * tooltip on the button surfaces the same copy for
               * sighted users. */}
              <span id="run-take-control-help" className="sr-only">
                Transfer Net Control authority to yourself for this session.
              </span>
              {takeControlAction.error && (
                <span
                  className="hna-input-error"
                  role="alert"
                  style={{ fontSize: 11 }}
                >
                  {takeControlAction.error}
                </span>
              )}
            </>
          )}
          {canRunNet && !session.endedAt && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                reassignAction.reset();
                setControlOpen(true);
              }}
            >
              Change control
            </Button>
          )}
          {/* Overflow (⋯) currently holds only the config-only "Edit net"
              action, so it is gated on canManageNet — a Net Control operator
              never sees it. Any future run-the-net items added here should move
              behind canRunNet instead. */}
          {canManageNet && (
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
          {canRunNet && (
            <Button variant="danger" size="sm" onClick={endNet}>
              End net
            </Button>
          )}
        </div>
      </div>

      {/* ===== 5-minute announcement (PREP, weekly nets only) =====
       *
       * Flashing warn strip shown while prepping when the wall clock is
       * within 5 minutes of the net's scheduled start (computed in the
       * net's own IANA timezone). Unmounted the moment the session goes
       * LIVE; the component itself hides once the window passes and
       * renders nothing for impromptu nets. */}
      {isPrep && <FiveMinuteAnnouncement net={net} />}

      {/* ===== Rack =====
       *
       * Two layouts share the same three blocks (roster + script +
       * chat); the wrapper class picks the layout:
       *
       *   PREP (`session.liveAt == null`): 2-col rack — operator is
       *     preparing, script center isn't the priority. Roster left,
       *     chat + script right.
       *
       *   LIVE: script-dominant rack — SCRIPT is the prominent
       *     top-left reading area (fills the viewport so no scrolling
       *     is needed); ROSTER (sticky check-in form + log) sits aside
       *     it; CHAT rides the top row at ≥1600px and otherwise wraps
       *     to a full-width row underneath. Script always stays at the
       *     top so it never "disappears" off-screen as the window
       *     shrinks (the bug the user reported).
       */}
      {(() => {
        // ===== TOPIC =====
        // Anyone who can run the net (NET_CONTROL+) can pick a queued
        // suggestion, type a custom topic, or clear the topic in both PREP and
        // LIVE — setting the net topic is a run-the-net action. In PREP the
        // full picker is
        // expanded inline; once LIVE it collapses to a compact read-only line
        // with an Edit/Add toggle that reveals the same picker on demand so the
        // running console stays tidy. Members only ever see the read-only line.
        const topicReadOnly = (
          <div
            className="hna-mono"
            data-testid="topic-readonly"
            style={{
              fontSize: 13,
              letterSpacing: '0.04em',
              color: currentTopic
                ? 'var(--color-fg)'
                : 'var(--color-fg-muted)',
            }}
          >
            {currentTopic ?? 'No topic set yet.'}
          </div>
        );

        // Small "Clear topic" affordance — shown when a topic is set, in the
        // PREP header and (inside the editor) in the LIVE state. Only one topic
        // card renders at a time so the shared testid never collides.
        const clearTopicButton = (
          <button
            type="button"
            className="hna-roster__btn"
            data-testid="topic-clear-button"
            onClick={clearTopic}
            disabled={topicBusy}
            aria-label="Clear topic"
            title="Clear topic"
          >
            Clear topic
          </button>
        );

        // The picker controls — OPEN suggestions (with the RECOMMENDED chip) and
        // the custom-topic input. Reused verbatim by the PREP card and the LIVE
        // inline editor so the pick / custom flows stay identical in both states.
        const topicPickerControls = (
          <>
            <SectionDivider>SUGGESTIONS</SectionDivider>
            {recommendedTopics.length === 0 ? (
              <div
                className="hna-empty"
                data-testid="topic-suggestions-empty"
                style={{ padding: 'var(--space-2) 0' }}
              >
                <p className="hna-empty__body" style={{ margin: 0 }}>
                  No open topic suggestions.
                </p>
              </div>
            ) : (
              <ul
                data-testid="topic-suggestions"
                style={{ listStyle: 'none', padding: 0, margin: 0 }}
              >
                {recommendedTopics.map((s) => (
                  <li
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 0',
                      borderBottom: '1px solid var(--color-border)',
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {s.recommended && (
                        <span
                          className="hna-chip hna-mono"
                          data-testid="topic-recommended-chip"
                          style={{
                            marginRight: 6,
                            fontSize: 10,
                            letterSpacing: '0.12em',
                          }}
                        >
                          RECOMMENDED
                        </span>
                      )}
                      {s.title}
                      {s.createdByCallsign && (
                        <span
                          className="hna-mono"
                          style={{
                            marginLeft: 6,
                            fontSize: 11,
                            color: 'var(--color-fg-muted)',
                          }}
                        >
                          {displayCallsign(s.createdByCallsign)}
                        </span>
                      )}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={topicBusy}
                      data-testid={`topic-use-${s.id}`}
                      onClick={() => applySuggestion(s)}
                    >
                      Use
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <SectionDivider>CUSTOM TOPIC</SectionDivider>
            <div
              className="hna-field"
              style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
            >
              <div style={{ flex: 1 }}>
                <label htmlFor="custom-topic-input">Custom topic</label>
                <Input
                  id="custom-topic-input"
                  value={customTopic}
                  onChange={(e) => setCustomTopic(e.target.value)}
                  placeholder="e.g. Field Day planning"
                  maxLength={200}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void setCustomTopicTitle();
                    }
                  }}
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={topicBusy || customTopic.trim().length === 0}
                data-testid="topic-set-custom-button"
                onClick={setCustomTopicTitle}
              >
                Set
              </Button>
            </div>
            {topicErr && (
              <p
                className="hna-input-error"
                role="alert"
                data-testid="topic-error"
                style={{ marginTop: 8 }}
              >
                {topicErr}
              </p>
            )}
          </>
        );

        const topicBlock =
          isPrep && canRunNet ? (
            // PREP (net control+): the full picker is expanded inline — the
            // operator is setting the topic before going live.
            <Card>
              <header className="hna-section-caption">
                <h2 className="hna-section-caption__title">
                  <span
                    className="hna-cap hna-cap--accent"
                    style={{ margin: 0 }}
                  >
                    [ TOPIC ]
                  </span>
                </h2>
                {currentTopic && clearTopicButton}
              </header>

              <div
                data-testid="topic-current"
                style={{ marginBottom: 'var(--space-3)' }}
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
                  Current
                </span>
                <div style={{ marginTop: 2 }}>{topicReadOnly}</div>
              </div>

              {topicPickerControls}
            </Card>
          ) : !isPrep && canRunNet ? (
            // LIVE (net control+): compact read-only line + an Edit/Add toggle. The
            // full picker is only revealed while actively editing so the running
            // console stays tidy; it collapses again after a change.
            <Card>
              <header className="hna-section-caption">
                <h2 className="hna-section-caption__title">
                  <span
                    className="hna-cap hna-cap--accent"
                    style={{ margin: 0 }}
                  >
                    [ TOPIC ]
                  </span>
                </h2>
                <button
                  type="button"
                  className="hna-roster__btn"
                  data-testid="topic-live-edit-toggle"
                  onClick={() => {
                    setTopicErr(null);
                    setLiveTopicEditorOpen((v) => !v);
                  }}
                  aria-expanded={liveTopicEditorOpen}
                  aria-label={
                    liveTopicEditorOpen
                      ? 'Close topic editor'
                      : currentTopic
                        ? 'Edit topic'
                        : 'Add topic'
                  }
                  title={
                    liveTopicEditorOpen
                      ? 'Close topic editor'
                      : currentTopic
                        ? 'Edit topic'
                        : 'Add topic'
                  }
                >
                  {liveTopicEditorOpen
                    ? 'Done'
                    : currentTopic
                      ? 'Edit topic'
                      : 'Add topic'}
                </button>
              </header>

              <div data-testid="topic-current">{topicReadOnly}</div>

              {liveTopicEditorOpen && (
                <div
                  data-testid="topic-live-editor"
                  style={{ marginTop: 'var(--space-3)' }}
                >
                  {currentTopic && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        marginBottom: 'var(--space-2)',
                      }}
                    >
                      {clearTopicButton}
                    </div>
                  )}
                  {topicPickerControls}
                </div>
              )}
            </Card>
          ) : currentTopic ? (
            <Card>
              <header className="hna-section-caption">
                <h2 className="hna-section-caption__title">
                  <span
                    className="hna-cap hna-cap--accent"
                    style={{ margin: 0 }}
                  >
                    [ TOPIC ]
                  </span>
                </h2>
              </header>
              {topicReadOnly}
            </Card>
          ) : null;

        const rosterBlock = (
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

            {isPrep && (
              <p
                className="hna-mono"
                data-testid="prep-checkin-hint"
                style={{
                  fontSize: 12,
                  letterSpacing: '0.06em',
                  color: 'var(--color-fg-muted)',
                  marginTop: 0,
                  marginBottom: 'var(--space-2)',
                }}
              >
                Press START NET to begin accepting check-ins.
              </p>
            )}
            <form
              className="hna-checkin-form"
              onSubmit={(e) => {
                e.preventDefault();
                void addCheckInAction.run();
              }}
              aria-disabled={isPrep}
              style={isPrep ? { opacity: 0.55 } : undefined}
            >
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
                        else void addCheckInAction.run();
                      }
                    }}
                  />
                </div>
              </div>
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
                  data-testid="checkin-mode-toggle"
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
                    data-testid="checkin-mode-rf"
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
                    data-testid="checkin-mode-echolink"
                  >
                    [ ECHOLINK ]
                  </button>
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
                      void addCheckInAction.run();
                    }
                  }}
                />
              </div>
              <div className="hna-checkin-form__actions">
                <Button
                  type="submit"
                  disabled={isPrep || addCheckInAction.pending}
                  data-testid="checkin-add-button"
                >
                  {addCheckInAction.pending ? 'Adding…' : 'Add'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void undoLastAction.run()}
                  disabled={isPrep || undoLastAction.pending}
                >
                  Undo
                </Button>
              </div>
              {(addCheckInAction.error || undoLastAction.error) && (
                <p className="hna-input-error" role="alert" style={{ marginTop: 6 }}>
                  {addCheckInAction.error || undoLastAction.error}
                </p>
              )}
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
                      <span className="hna-roster__cs-line">
                        <OnlineDot online={isOnlineByCallsign(ci.callsign)} />
                        {displayCallsign(ci.callsign)}
                      </span>
                      {/* The mode chip rides on its own line UNDER the
                       * callsign — inline it inflated the callsign column
                       * until the badge painted over the time cell and the
                       * name column collapsed to one letter. */}
                      {ci.mode === 'echolink' && (
                        <span
                          className="hna-chip hna-roster__mode-chip"
                          data-testid="echolink-chip"
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
                        onClick={() => {
                          if (canEdit) {
                            deleteCheckInAction.reset();
                            setConfirmDeleteId(ci.id);
                          }
                        }}
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
        );

        const chatBlock = (
          <ChatBox sessionId={session.id} liveAt={session.liveAt ?? null} />
        );

        const scriptBlock = (
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
              {canManageNet && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditNetOpen(true)}
                >
                  Edit net
                </Button>
              )}
            </header>
            <SanitizedHtml
              className="hna-script-html hna-script-panel"
              html={scriptToHtml(net?.scriptMd ?? '')}
            />
          </Card>
        );

        // Both PREP and LIVE use the script-dominant rack. SCRIPT is the
        // prominent top-left reading area; ROSTER sits aside it; CHAT rides
        // in the top row when the viewport is wide enough (≥1600px) and
        // otherwise wraps to a full-width row underneath ("chat at the top
        // if it fits, otherwise chat under"). The roster's check-in form is
        // sticky at the top of its column so officers can add a check-in
        // without scrolling regardless of how long the log grows. In PREP
        // the check-in form is disabled (handled inside rosterBlock via
        // `isPrep`), but the script-top arrangement is the same so the
        // operator reads the script first whether preparing or running.
        // Breakpoint behavior lives in ui.css (`.hna-runnet-live` rules).
        return (
          <div className="hna-runnet-live">
            <div className="hna-runnet-live__script">{scriptBlock}</div>
            <div className="hna-runnet-live__roster">
              {topicBlock && (
                <div className="hna-runnet-live__topic">{topicBlock}</div>
              )}
              <div className="hna-runnet-live__checkin">{rosterBlock}</div>
            </div>
            <div className="hna-runnet-live__chat">{chatBlock}</div>
          </div>
        );
      })()}

      {/* ===== End-of-net review modal ===== */}
      <Modal
        open={reviewOpen}
        onClose={() => {
          setReviewOpen(false);
          endNetAction.reset();
        }}
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
        {endNetAction.error && (
          <p
            className="hna-input-error"
            role="alert"
            style={{ marginTop: 12, marginBottom: 0 }}
          >
            {endNetAction.error}
          </p>
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
            disabled={endNetAction.pending}
            onClick={() => {
              setReviewOpen(false);
              endNetAction.reset();
            }}
          >
            Keep running
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={endNetAction.pending}
            onClick={() => void endNetAction.run()}
          >
            {endNetAction.pending ? 'Ending…' : 'End net'}
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
        onClose={() => {
          setControlOpen(false);
          reassignAction.reset();
        }}
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
                disabled={session.controlOpId === c.id || reassignAction.pending}
                onClick={() => void reassignAction.run(c.id)}
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
        {reassignAction.error && (
          <p className="hna-input-error" role="alert" style={{ marginTop: 8 }}>
            {reassignAction.error}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <Button
            variant="secondary"
            onClick={() => {
              setControlOpen(false);
              reassignAction.reset();
            }}
          >
            Close
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        open={confirmDeleteId !== null}
        title="Delete check-in"
        message={
          <>
            Delete this check-in?
            {deleteCheckInAction.error && (
              <span
                className="hna-input-error"
                role="alert"
                style={{ display: 'block', marginTop: 8 }}
              >
                {deleteCheckInAction.error}
              </span>
            )}
          </>
        }
        confirmLabel="Delete"
        onClose={() => {
          setConfirmDeleteId(null);
          deleteCheckInAction.reset();
        }}
        onConfirm={() => {
          if (confirmDeleteId) void deleteCheckInAction.run(confirmDeleteId);
        }}
      />
    </div>
  );
}
