import React, { useEffect, useState } from 'react';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { apiFetch, isAbortError } from '../api/client.js';

interface Topic {
  id: string;
  title: string;
  details?: string | null;
  status: string;
}

interface StartedSession {
  id: string;
}

export function StartNetModal({
  open,
  netId,
  netName,
  onClose,
  onStarted,
}: {
  open: boolean;
  netId: string;
  netName: string;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selected, setSelected] = useState<string>('__none__');
  const [customTitle, setCustomTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected('__none__');
    setCustomTitle('');
    setErr(null);
    const ctrl = new AbortController();
    apiFetch<Topic[]>('/topics', { signal: ctrl.signal })
      .then((rows) => setTopics(rows.filter((r) => r.status === 'OPEN')))
      .catch((e) => {
        if (!isAbortError(e)) setErr((e as Error).message);
      });
    return () => ctrl.abort();
  }, [open]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: { topicId?: string; topicTitle?: string } = {};
      if (customTitle.trim().length > 0) {
        body.topicTitle = customTitle.trim();
      } else if (selected !== '__none__') {
        body.topicId = selected;
      }
      const s = await apiFetch<StartedSession>(`/nets/${netId}/sessions`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onStarted(s.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose}>
      <div>
        <h2 style={{ marginTop: 0 }}>Start {netName}</h2>
        <p>Pick a topic for tonight&rsquo;s net (optional).</p>
        <div
          style={{
            maxHeight: 240,
            overflowY: 'auto',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            padding: 8,
            marginBottom: 12,
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 4 }}>
            <input
              type="radio"
              name="topic"
              checked={selected === '__none__'}
              onChange={() => {
                setSelected('__none__');
                setCustomTitle('');
              }}
            />
            <span>No topic</span>
          </label>
          {topics.map((t) => (
            <label
              key={t.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 4 }}
            >
              <input
                type="radio"
                name="topic"
                checked={selected === t.id}
                onChange={() => {
                  setSelected(t.id);
                  setCustomTitle('');
                }}
              />
              <span>{t.title}</span>
            </label>
          ))}
          {topics.length === 0 && (
            <div style={{ color: 'var(--color-muted)', padding: 4 }}>
              No open topic suggestions.
            </div>
          )}
        </div>
        <label>
          Or enter a custom topic
          <Input
            value={customTitle}
            onChange={(e) => {
              setCustomTitle(e.target.value);
              if (e.target.value.length > 0) setSelected('__custom__');
              else setSelected('__none__');
            }}
            placeholder="e.g. Field Day planning"
          />
        </label>
        {err && (
          <div style={{ color: 'var(--color-danger)', marginTop: 8 }}>{err}</div>
        )}
        <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? 'Starting…' : 'Start net'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
