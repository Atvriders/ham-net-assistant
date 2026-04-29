import React, { useEffect, useRef, useState } from 'react';
import type { SessionMessage } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { displayCallsign } from '../lib/format.js';

interface Props {
  sessionId: string;
}

export function ChatBox({ sessionId }: Props) {
  const { user } = useAuth();
  const { data, refresh } = useAutoFetch<SessionMessage[]>(
    `/sessions/${sessionId}/messages`,
    { intervalMs: 3000 },
  );
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [discordBridged, setDiscordBridged] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const messages = data ?? [];

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ enabled: boolean }>('/discord/status')
      .then((r) => { if (!cancelled) setDiscordBridged(r.enabled); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

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

  async function deleteMsg(id: string) {
    if (!confirm('Delete this message?')) return;
    try {
      await apiFetch(`/messages/${id}`, { method: 'DELETE' });
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
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        Chat
        <span style={{ fontSize: 11, color: 'var(--color-success)' }}>● live</span>
        {discordBridged && (
          <span
            style={{
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 10,
              background: 'var(--color-bg-muted)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-fg)',
              opacity: 0.85,
            }}
            title="In-app chat mirrors to a Discord channel during this net"
          >
            Bridged with Discord
          </span>
        )}
      </h3>
      <div
        ref={listRef}
        style={{
          height: 320,
          overflowY: 'auto',
          background: 'var(--color-bg-muted)',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: 'var(--color-fg)', opacity: 0.6, fontStyle: 'italic' }}>
            No messages yet.
          </div>
        )}
        {messages.map((m) => {
          const mine = user && m.userId === user.id;
          const recent = Date.now() - new Date(m.createdAt).getTime() < 5 * 60 * 1000;
          const canDelete =
            (user && (user.role === 'OFFICER' || user.role === 'ADMIN')) ||
            (mine && recent);
          return (
            <div
              key={m.id}
              style={{
                alignSelf: mine ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                background: mine ? 'var(--color-primary)' : 'var(--color-bg)',
                color: mine ? 'var(--color-primary-fg)' : 'var(--color-fg)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                padding: '6px 10px',
              }}
            >
              <div style={{ fontSize: 11, opacity: 0.8 }}>
                <span className="hna-callsign">{displayCallsign(m.callsign)}</span> · {m.nameAtMessage} ·{' '}
                {new Date(m.createdAt).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}
                {canDelete && (
                  <button
                    onClick={() => deleteMsg(m.id)}
                    style={{
                      marginLeft: 8,
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      opacity: 0.6,
                    }}
                    aria-label="Delete message"
                  >
                    ×
                  </button>
                )}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {m.body}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <textarea
          className="hna-input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message — Enter to send, Shift+Enter for newline"
          maxLength={500}
          style={{ flex: 1, resize: 'vertical' }}
          disabled={submitting || !user}
        />
        <Button onClick={send} disabled={submitting || !text.trim() || !user}>
          Send
        </Button>
      </div>
      {err && <div style={{ color: 'var(--color-danger)', marginTop: 6 }}>{err}</div>}
    </Card>
  );
}
