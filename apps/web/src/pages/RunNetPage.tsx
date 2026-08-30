import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CheckIn, NetSession, Net, Repeater } from '@hna/shared';
import { roleAtLeast } from '@hna/shared';
import {
  apiFetch,
  isAbortError,
  ApiErrorException,
  errorMessage,
} from '../api/client.js';
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
import { RecentCallsigns, type RecentCallsign } from '../components/RecentCallsigns.js';
import { RepeaterFacts } from '../components/RepeaterFacts.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';

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

/** How long the green "NET IS LIVE" confirmation stays on screen, in ms. */
const NET_STARTED_MS = 6_000;

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

/**
 * Publish the measured heights of the two pieces of sticky chrome the console
 * stacks against — the app-shell nav and this page's status strip — as the
 * `--nav-h` / `--runnet-status-h` custom properties on <html>.
 *
 * WHY: those offsets used to be the constants 56px and 88px. Below 1024px
 * there is no hamburger and `.hna-shell__tail` wraps, so the real nav is
 * 150-230px tall — the status strip (and with it START NET / Take control /
 * END NET) slid underneath the opaque nav as soon as a phone operator
 * scrolled, i.e. the controls for running a live net vanished. Measuring
 * tracks wrapping, viewport resize and theme swaps (a theme changes the nav's
 * fonts and therefore its height) instead of guessing.
 */
function useStickyChromeVars(
  statusEl: HTMLElement | null,
  dockEl: HTMLElement | null,
) {
  useEffect(() => {
    const root = document.documentElement;
    const nav = document.querySelector<HTMLElement>('.hna-shell__nav');
    const targets: Array<[HTMLElement, string]> = [];
    if (nav) targets.push([nav, '--nav-h']);
    if (statusEl) targets.push([statusEl, '--runnet-status-h']);
    // The phone dock is fixed to the bottom of the viewport, so the page has
    // to reserve exactly its height or the last rows of the log sit
    // permanently underneath it — unreachable, because scrolling further just
    // moves the dock with the viewport. Measured rather than guessed: the
    // dock grows when it expands and when a wrapped error appears.
    if (dockEl) targets.push([dockEl, '--runnet-dock-h']);
    if (targets.length === 0) return;

    const apply = () => {
      for (const [el, prop] of targets) {
        const h = Math.round(el.getBoundingClientRect().height);
        // A zero height means "not laid out" — the element is display:none, or
        // we're in jsdom, which has no layout engine at all. Leaving the
        // property unset keeps the CSS fallback in theme-vars.css rather than
        // collapsing the offset to 0 and hiding the strip under the nav.
        if (h > 0) root.style.setProperty(prop, `${h}px`);
      }
    };
    const clear = () => {
      for (const [, prop] of targets) root.style.removeProperty(prop);
    };

    apply();
    // ResizeObserver is missing in jsdom and in a few old mobile browsers.
    // Degrade to resize events: still correct on rotate/resize, just blind to
    // content-driven reflows of the nav itself.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply);
      return () => {
        window.removeEventListener('resize', apply);
        clear();
      };
    }
    const ro = new ResizeObserver(apply);
    for (const [el] of targets) ro.observe(el);
    return () => {
      ro.disconnect();
      clear();
    };
  }, [statusEl, dockEl]);
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
  const {
    data: session,
    error: sessionError,
    refresh,
  } = useAutoFetch<SessionResponse>(
    sessionId ? `/sessions/${sessionId}` : null,
    { intervalMs: 3000 },
  );
  const [net, setNet] = useState<NetFull | null>(null);
  // Failure of the /nets fallback below. Tracked separately from the session
  // fetch because a session can load fine while its net lookup 404s — without
  // this the page would sit on "Loading session…" forever.
  const [netError, setNetError] = useState<string | null>(null);
  // Bumped by the error card's Retry button to re-run the /nets fallback (the
  // session itself is re-fetched by `refresh`).
  const [netLoadNonce, setNetLoadNonce] = useState(0);
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
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const rosterListRef = useRef<HTMLUListElement>(null);
  // Callback ref (state, not useRef) so the measuring effect re-runs when the
  // status strip mounts — it only exists once the session payload has loaded.
  const [statusEl, setStatusEl] = useState<HTMLDivElement | null>(null);
  const [dockEl, setDockEl] = useState<HTMLFormElement | null>(null);
  useStickyChromeVars(statusEl, dockEl);
  // Below 1024px the check-in entry becomes a dock fixed to the bottom of the
  // viewport, collapsed to callsign + Add. Kept in JS as well as CSS because
  // the collapsed fields must leave the DOM, not merely be painted away — see
  // useMediaQuery. Falls back to `false` (full form) wherever matchMedia is
  // unavailable, so nothing is ever hidden by accident.
  const isNarrow = useMediaQuery('(max-width: 1023px)');
  const [dockOpen, setDockOpen] = useState(false);
  const showEntryExtras = !isNarrow || dockOpen;
  const [recent, setRecent] = useState<RecentCallsign[]>([]);
  const prevCheckInCountRef = useRef<number | null>(null);
  const lastAutoFilledNameRef = useRef<string>('');
  // One green blink at the PREP -> LIVE moment. Only a transition observed
  // while this console is open counts: the ref starts null, so opening a
  // session that is ALREADY live records the state without announcing it.
  const [justWentLive, setJustWentLive] = useState(false);
  const prevIsLiveRef = useRef<boolean | null>(null);
  const isLive = session ? session.liveAt != null : null;
  useEffect(() => {
    if (isLive === null) return;
    const prev = prevIsLiveRef.current;
    prevIsLiveRef.current = isLive;
    if (prev === false && isLive) setJustWentLive(true);
  }, [isLive]);
  useEffect(() => {
    if (!justWentLive) return;
    // Long enough to be read (the blink itself is 1.2s), short enough that it
    // doesn't become another permanent bar — the LIVE chip in the status strip
    // is what carries the state from here on.
    const id = window.setTimeout(() => setJustWentLive(false), NET_STARTED_MS);
    return () => window.clearTimeout(id);
  }, [justWentLive]);
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
      setNetError(null);
      return;
    }
    const ctrl = new AbortController();
    apiFetch<NetFull[]>('/nets', { signal: ctrl.signal })
      .then((nets) => {
        const match = nets.find((x) => x.id === session.netId) ?? null;
        setNet(match);
        // A session whose net is gone is a dead end, not a slow load — say so
        // instead of spinning.
        setNetError(
          match ? null : 'This session references a net that no longer exists.',
        );
      })
      .catch((e) => {
        if (!isAbortError(e)) setNetError(errorMessage(e));
      });
    return () => ctrl.abort();
  }, [session, netLoadNonce]);

  // This net's regulars, most recently heard first — the tap-to-fill strip
  // above the check-in entry. Keyed to the net, not the club, because who
  // checks into the Tuesday tech net is not who checks into Sunday's swap net.
  //
  // Best-effort: a failure (or an API that predates the route) leaves the list
  // empty and the strip renders nothing. Typing a callsign has to keep working
  // when a convenience does not.
  useEffect(() => {
    const netId = session?.netId;
    if (!netId) return;
    const ctrl = new AbortController();
    apiFetch<RecentCallsign[]>(`/nets/${netId}/recent-checkins?limit=12`, {
      signal: ctrl.signal,
    })
      .then(setRecent)
      .catch((e) => {
        if (!isAbortError(e)) console.warn('recent check-ins load failed', e);
      });
    return () => ctrl.abort();
  }, [session?.netId]);

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

  // The LOG lists check-ins oldest-first, so a new check-in appends at the
  // BOTTOM. When one arrives, nudge the newest row into view (the roster has
  // no inner scroll container — the page scrolls — so a long log would
  // otherwise hide the row that was just added). Skips the initial load so
  // opening the page doesn't jump, and never fires on deletes/undo.
  // null until the session payload has actually loaded — seeding the counter
  // with 0 during the loading render would make the first loaded payload look
  // like an "increase" and scroll the page on open.
  const checkInCount = session ? session.checkIns.length : null;
  useEffect(() => {
    if (checkInCount === null) return;
    const prev = prevCheckInCountRef.current;
    prevCheckInCountRef.current = checkInCount;
    if (prev === null || checkInCount <= prev) return;
    const lastRow = rosterListRef.current?.lastElementChild;
    // scrollIntoView is missing in jsdom — guard rather than polyfill.
    if (lastRow && typeof lastRow.scrollIntoView === 'function') {
      lastRow.scrollIntoView({ block: 'nearest' });
    }
  }, [checkInCount]);

  // Dismiss the overflow disclosure on an outside click or Escape.
  //
  // It is a disclosure (a button that reveals a small panel), NOT an ARIA
  // menu: role="menu" promises roving tabindex + arrow-key navigation +
  // typeahead, none of which this ever implemented, so screen-reader users
  // were told to press keys that did nothing. Escape-to-close with focus
  // returned to the trigger is the part that genuinely matters, and it is the
  // whole keyboard contract a disclosure owes.
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
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      setOverflowOpen(false);
      // Focus would otherwise be stranded on the removed panel and fall back
      // to <body>, costing a keyboard operator their place in the strip.
      overflowBtnRef.current?.focus();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
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

  // Note: a bare Backspace in an empty callsign field used to delete the most
  // recent check-in with no confirmation. Removed rather than wrapped in a
  // dialog: over-backspacing a mistyped callsign is the single most common
  // keystroke in this field, the deletion was silent and un-signposted, and
  // the same operation already has a labelled, guarded Undo button two rows
  // below. Adding a confirm dialog would only have made the accidental path
  // interrupt the operator mid-net instead of removing it.
  function onCallsignKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
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

  // Non-happy load paths. Only reached before the console has ever rendered:
  // once `session` is populated a failing poll leaves the last good payload on
  // screen, because yanking a live console away from the operator over one
  // dropped request would be worse than a stale elapsed timer.
  if (!session || !net) {
    const loadError = !sessionId
      ? 'This link has no session id.'
      : !session
        ? sessionError
        : netError;
    if (loadError) {
      // A deleted or mistyped session id 404s. Without this the net-control
      // operator sat on "Loading session…" forever with no error and no way
      // to retry — the exact state a live net cannot afford.
      return (
        <div className="hna-runnet-page">
          <header className="hna-page-header">
            <p className="hna-page-marker">// 04 — RUNNING NET</p>
            <h1 className="hna-page-title">Session unavailable</h1>
          </header>
          <Card>
            <div className="hna-empty" data-testid="runnet-load-error">
              <p className="hna-empty__title" role="alert">
                Couldn&rsquo;t load this session.
              </p>
              <p className="hna-empty__body">{loadError}</p>
              <div className="hna-empty__actions">
                <Button
                  variant="primary"
                  onClick={() => {
                    setNetError(null);
                    setNetLoadNonce((n) => n + 1);
                    void refresh();
                  }}
                >
                  Retry
                </Button>
                <Button variant="secondary" onClick={() => nav('/')}>
                  Back to dashboard
                </Button>
              </div>
            </div>
          </Card>
        </div>
      );
    }
    return (
      <div style={{ padding: 24 }} data-testid="runnet-loading">
        Loading session…
      </div>
    );
  }

  const suggestions =
    callsign.length > 0
      ? directory
          .filter((d) => d.callsign.includes(callsign.toUpperCase()))
          .slice(0, 8)
      : directory.slice(0, 8);

  const scriptCategoryLabel =
    SCRIPT_CATEGORY_LABELS[net.scriptCategory ?? 'general'] ?? 'General';
  // The API returns check-ins newest-first (desc); the LOG displays them
  // OLDEST-FIRST — "#01" (first to check in) at the top, the newest appended
  // at the bottom. Copy-then-reverse so the session payload itself is never
  // mutated: undoLastAction still reads `session.checkIns[0]` as the most
  // recent check-in.
  const checkInsOldestFirst = [...session.checkIns].reverse();
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
      <div
        className="hna-runnet-status"
        role="region"
        aria-label="Net status"
        ref={setStatusEl}
      >
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
            {/* Clubs routinely NAME a repeater after its frequency, so the
                strip read "W0QQQ 145.41 · 145.410 MHz". RepeaterFacts drops
                the copy embedded in the name (only when it IS this
                frequency) and keeps the formatted one — and carries the
                linked machines, which an operator has to announce on the
                air when the net is running linked. */}
            <RepeaterFacts repeater={net.repeater} links={net.links} compact />
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
                ref={overflowBtnRef}
                className="hna-overflow__btn"
                aria-label="More actions"
                aria-expanded={overflowOpen}
                aria-controls="run-overflow-panel"
                title="More actions"
                onClick={() => setOverflowOpen((v) => !v)}
              >
                ⋯
              </button>
              {overflowOpen && (
                <div className="hna-overflow__menu" id="run-overflow-panel">
                  <Button
                    variant="ghost"
                    size="sm"
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

      {/* ===== Auto-start countdown / 5-minute announcement (PREP, weekly
       * nets only) =====
       *
       * One strip: a per-second "// AUTO-START IN MM:SS" countdown to the
       * scheduled start (the server auto-starts the PREP session at that
       * time), which flips to the flashing 5-minute-announcement treatment
       * inside the last five minutes and to "// STARTING…" at zero. All
       * times are computed in the net's own IANA timezone. `onStartDue`
       * refetches the session the moment the countdown hits zero so the
       * console flips to LIVE without waiting for the next poll tick — the
       * client never starts the session itself. Unmounted the moment the
       * session goes LIVE (so the 1s tick never runs while LIVE); the
       * component renders nothing for impromptu nets. */}
      {isPrep && <FiveMinuteAnnouncement net={net} onStartDue={refresh} />}

      {/* The countdown strip's slot, reused for the moment it was counting
          down to: one green blink confirming the net is on the air. */}
      {!isPrep && justWentLive && (
        <div className="hna-netstarted hna-mono" role="status" data-testid="net-started-flash">
          {'// NET IS LIVE'}
        </div>
      )}

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
              ref={setDockEl}
              // The dock only engages on a LIVE net: during PREP the entry is
              // disabled, and pinning a dimmed, unusable bar over the script
              // the operator is rehearsing would cost screen for nothing.
              className={
                isNarrow && !isPrep
                  ? `hna-checkin-form hna-checkin-form--dock${dockOpen ? ' is-open' : ''}`
                  : 'hna-checkin-form'
              }
              onSubmit={(e) => {
                e.preventDefault();
                void addCheckInAction.run();
              }}
              aria-disabled={isPrep}
              style={isPrep ? { opacity: 0.55 } : undefined}
            >
              <RecentCallsigns
                recent={recent}
                alreadyCheckedIn={session.checkIns.map((c) => c.callsign)}
                onPick={(entry) => {
                  setCallsign(entry.callsign);
                  setName(entry.name);
                  inputRef.current?.focus();
                }}
                disabled={isPrep}
              />
              <div className="hna-checkin-form__row">
                <div className="hna-field">
                  <label htmlFor="checkin-callsign-input">Callsign</label>
                  <div onKeyDown={onCallsignKeyDown}>
                    <CallsignInput
                      ref={inputRef}
                      id="checkin-callsign-input"
                      value={callsign}
                      onChange={setCallsign}
                      autoFocus={!isNarrow}
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
                <div className="hna-field" hidden={!showEntryExtras}>
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
                hidden={!showEntryExtras}
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
              <div className="hna-field" hidden={!showEntryExtras}>
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
              {/* Collapsed dock: the resolved name is the only confirmation the
                  operator needs before pressing Add, and it costs one line
                  instead of a whole field. Auto-filled from the club
                  directory / FCC lookup, so it is usually already right. */}
              {isNarrow && !dockOpen && name.trim() !== '' && (
                <p
                  className="hna-checkin-form__resolved hna-mono"
                  data-testid="dock-resolved-name"
                >
                  <span aria-hidden="true">→ </span>
                  {name}
                </p>
              )}
              <div className="hna-checkin-form__actions">
                <Button
                  type="submit"
                  disabled={isPrep || addCheckInAction.pending}
                  data-testid="checkin-add-button"
                >
                  {addCheckInAction.pending ? 'Adding…' : 'Add'}
                </Button>
                <span hidden={!showEntryExtras}>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void undoLastAction.run()}
                    disabled={isPrep || undoLastAction.pending}
                  >
                    Undo
                  </Button>
                </span>
                {isNarrow && (
                  <button
                    type="button"
                    className="hna-checkin-form__toggle hna-mono"
                    onClick={() => setDockOpen((v) => !v)}
                    aria-expanded={dockOpen}
                    aria-controls="checkin-name-input"
                    data-testid="dock-toggle"
                  >
                    {dockOpen ? '[ LESS ]' : '[ MORE ]'}
                  </button>
                )}
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
              ref={rosterListRef}
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Check-in log"
            >
              {checkInsOldestFirst.length === 0 && (
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
              {checkInsOldestFirst.map((ci, displayIdx) => {
                // displayIdx is oldest-first, so the 1-based check-in order
                // is direct: "#01" (first to check in) sits at the top.
                const ord = displayIdx + 1;
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
                    {/* title always reveals the full name on hover; the CSS
                     * lets the cell wrap to a second line so it also fits
                     * visibly (see .hna-roster__name in ui.css). */}
                    <span className="hna-roster__name" title={ci.nameAtCheckIn}>
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
