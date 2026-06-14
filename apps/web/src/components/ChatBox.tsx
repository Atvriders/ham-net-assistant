import React, { useEffect, useRef, useState } from 'react';
import type { SessionMessage, MessageReaction } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { ConfirmModal } from './ui/ConfirmModal.js';
import { LiveDot } from './ui/LiveDot.js';
import { displayCallsign } from '../lib/format.js';

interface Props {
  sessionId: string;
  /// Optional prep-state hint. When `liveAt` is null the divider label switches
  /// from "NET STARTED" to "SESSION OPENED" to match the prep semantics on
  /// RunNetPage and JoinNetPage. Older callers can omit this and get the
  /// existing live-only behavior.
  liveAt?: string | null;
}

const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '📡', '⚡'];

function groupReactions(rs: MessageReaction[]): Record<string, MessageReaction[]> {
  const out: Record<string, MessageReaction[]> = {};
  for (const r of rs) {
    const list = out[r.emoji] ?? [];
    list.push(r);
    out[r.emoji] = list;
  }
  return out;
}

export function ChatBox({ sessionId, liveAt }: Props) {
  // PREP-state aware label: when liveAt is null the session has been opened
  // but not yet started, so the divider reads "SESSION OPENED" instead of the
  // post-start "NET STARTED" used while the net is live.
  const dividerLabel = liveAt === null ? 'SESSION OPENED' : 'NET STARTED';
  const { user } = useAuth();
  const { data, refresh } = useAutoFetch<SessionMessage[]>(
    `/sessions/${sessionId}/messages`,
    { intervalMs: 3000 },
  );
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [discordBridged, setDiscordBridged] = useState(false);
  const [pickerForId, setPickerForId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const messages = data ?? [];

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ enabled: boolean }>('/discord/status')
      .then((r) => { if (!cancelled) setDiscordBridged(r.enabled); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  // Jump to the bottom of the most recent message whenever the message count
  // changes — this covers initial mount (so the panel opens already scrolled
  // down through any 24h backfill rows) and any new arrivals.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, sessionId]);

  // Identify where the backfill (other sessions, last 24h) ends and the
  // current session begins, so we can render a subtle divider between them.
  // If the current session has no messages yet, `firstCurrentIdx` is -1 —
  // treat that as "all loaded rows are backfill" and render the divider at
  // the end of the list.
  const firstCurrentIdxRaw = messages.findIndex((m) => m.sessionId === sessionId);
  const backfillCount = firstCurrentIdxRaw < 0
    ? messages.filter((m) => m.sessionId !== sessionId).length
    : firstCurrentIdxRaw;
  const hasBackfill = backfillCount > 0;
  const dividerAtIdx = firstCurrentIdxRaw < 0 ? messages.length : firstCurrentIdxRaw;

  async function send() {
    const body = text.trim();
    if (!body) return;
    setSubmitting(true);
    setErr(null);
    try {
      await apiFetch(`/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      setText('');
      await refresh();
    } catch (e) {
      if (e instanceof ApiErrorException) setErr(e.payload.message);
      else setErr('Failed to send');
    } finally {
      setSubmitting(false);
    }
  }

  async function performDelete(id: string) {
    try {
      await apiFetch(`/messages/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      if (e instanceof ApiErrorException) setErr(e.payload.message);
    } finally {
      setConfirmDeleteId(null);
    }
  }

  async function addReaction(messageId: string, emoji: string) {
    try {
      await apiFetch(`/messages/${messageId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      });
      setPickerForId(null);
      await refresh();
    } catch (e) {
      if (e instanceof ApiErrorException) setErr(e.payload.message);
    }
  }

  async function removeReaction(messageId: string, emoji: string) {
    try {
      await apiFetch(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
        method: 'DELETE',
      });
      await refresh();
    } catch (e) {
      if (e instanceof ApiErrorException) setErr(e.payload.message);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <Card>
      <header
        className="hna-section-caption"
        style={{ alignItems: 'center' }}
      >
        <h3 className="hna-section-caption__title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="hna-cap hna-cap--accent" style={{ margin: 0 }}>[ CHAT ]</span>
          <span aria-hidden="true" style={{ width: 1 }} />
          <LiveDot />
        </h3>
        {discordBridged && (
          <span
            className="hna-chip"
            title="In-app chat mirrors to a Discord channel during this net"
          >
            Bridged · Discord
          </span>
        )}
      </header>
      <div
        ref={listRef}
        className="hna-chat__list"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Session chat"
      >
        {messages.length === 0 && (
          <div className="hna-chat__empty">No messages yet.</div>
        )}
        {hasBackfill && (
          <div
            className="hna-section-divider"
            style={{ margin: '0 0 var(--space-2)' }}
            role="separator"
          >
            <span>— PRE-NET CONTEXT —</span>
          </div>
        )}
        {messages.map((m, idx) => {
          const dividerHere = hasBackfill && idx === dividerAtIdx;
          const mine = user && m.userId === user.id;
          const recent = Date.now() - new Date(m.createdAt).getTime() < 5 * 60 * 1000;
          const canDelete =
            (user && (user.role === 'OFFICER' || user.role === 'ADMIN')) ||
            (mine && recent);
          const reactions = m.reactions ?? [];
          const grouped = groupReactions(reactions);
          const isBackfill = m.sessionId !== sessionId;
          return (
            <React.Fragment key={m.id}>
              {dividerHere && (
                <div
                  data-testid="net-started-divider"
                  className="hna-section-divider"
                  style={{ margin: 'var(--space-2) 0', color: 'var(--color-primary)' }}
                  role="separator"
                >
                  <span>— {dividerLabel} —</span>
                </div>
              )}
              <div
                className={[
                  'hna-chat__bubble',
                  mine ? 'hna-chat__bubble--mine' : '',
                  isBackfill ? 'hna-chat__bubble--backfill' : '',
                ].filter(Boolean).join(' ')}
              >
                <div className="hna-chat__bubble-head">
                  <strong>{displayCallsign(m.callsign)}</strong>
                  <span style={{ opacity: 0.7 }}>· {m.nameAtMessage}</span>
                  <span>·</span>
                  <span>
                    {new Date(m.createdAt).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true,
                    })}
                  </span>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(m.id)}
                      className="hna-chat__bubble-del"
                      aria-label="Delete message"
                      title="Delete message"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="hna-chat__bubble-body">{m.body}</div>
                {(Object.keys(grouped).length > 0 || user) && (
                  <div className="hna-chat__reactions">
                    {Object.entries(grouped).map(([emoji, group]) => {
                      const myRow = user ? group.some((r) => r.userId === user.id) : false;
                      return (
                        <button
                          type="button"
                          key={emoji}
                          onClick={() =>
                            myRow ? removeReaction(m.id, emoji) : addReaction(m.id, emoji)
                          }
                          className={`hna-chat__react-chip ${myRow ? 'hna-chat__react-chip--mine' : ''}`}
                          aria-label={`${emoji} ${group.length}`}
                          disabled={!user}
                        >
                          <span>{emoji}</span>
                          <span style={{ opacity: 0.8 }}>{group.length}</span>
                        </button>
                      );
                    })}
                    {user && (
                      <button
                        type="button"
                        onClick={() => setPickerForId(pickerForId === m.id ? null : m.id)}
                        className="hna-chat__react-add"
                        aria-label="Add reaction"
                        title="Add reaction"
                      >
                        + 🙂
                      </button>
                    )}
                    {pickerForId === m.id && (
                      <div className="hna-chat__react-picker">
                        {QUICK_EMOJI.map((e) => (
                          <button
                            type="button"
                            key={e}
                            onClick={() => addReaction(m.id, e)}
                            aria-label={`React with ${e}`}
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        {hasBackfill && dividerAtIdx === messages.length && (
          <div
            data-testid="net-started-divider"
            className="hna-section-divider"
            style={{ margin: 'var(--space-2) 0', color: 'var(--color-primary)' }}
            role="separator"
          >
            <span>— NET STARTED —</span>
          </div>
        )}
      </div>
      <div className="hna-chat__compose">
        <textarea
          className="hna-input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message — Enter to send, Shift+Enter for newline"
          maxLength={500}
          aria-label="New chat message"
          disabled={submitting || !user}
        />
        <Button onClick={send} disabled={submitting || !text.trim() || !user}>
          Send
        </Button>
      </div>
      {err && (
        <div
          className="hna-input-error"
          role="alert"
          style={{ marginTop: 6 }}
        >
          {err}
        </div>
      )}
      <ConfirmModal
        open={confirmDeleteId !== null}
        title="Delete message"
        message="Delete this message?"
        confirmLabel="Delete"
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) void performDelete(confirmDeleteId);
        }}
      />
    </Card>
  );
}
