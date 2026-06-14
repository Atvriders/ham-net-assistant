import React, { useEffect, useId, useState } from 'react';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { apiFetch, isAbortError, ApiErrorException } from '../api/client.js';

interface Topic {
  id: string;
  title: string;
  details?: string | null;
  status: string;
}

interface StartedSession {
  id: string;
}

/**
 * Topic-mode radio above the two sections — picks which source of truth wins
 * at submit. The previous design quietly clobbered radio selections when a
 * non-empty custom topic was typed (and vice-versa); making the source of
 * truth explicit removes that footgun.
 */
type TopicMode = 'none' | 'suggested' | 'custom';

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
  const [mode, setMode] = useState<TopicMode>('none');
  const [selected, setSelected] = useState<string>('');
  const [customTitle, setCustomTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const modeGroupName = useId();
  const suggestedGroupName = useId();
  const customInputId = useId();
  const dialogTitleId = useId();

  useEffect(() => {
    if (!open) return;
    setMode('none');
    setSelected('');
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
      if (mode === 'suggested') {
        if (!selected) {
          setErr('Pick a suggested topic, or switch modes.');
          setSubmitting(false);
          return;
        }
        body.topicId = selected;
      } else if (mode === 'custom') {
        const trimmed = customTitle.trim();
        if (!trimmed) {
          setErr('Enter a topic title, or switch modes.');
          setSubmitting(false);
          return;
        }
        body.topicTitle = trimmed;
      }
      // mode === 'none' sends an empty body (no topic).
      const s = await apiFetch<StartedSession & { reused?: boolean }>(
        `/nets/${netId}/sessions`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      onStarted(s.id);
    } catch (e) {
      if (e instanceof ApiErrorException && e.payload.code === 'CONFLICT') {
        setErr(e.payload.message);
      } else {
        setErr((e as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} titleId={dialogTitleId}>
      <div>
        <h2 id={dialogTitleId} style={{ marginTop: 0 }}>
          Open {netName}
        </h2>
        <p>
          Pick a topic for tonight&rsquo;s net (optional). The net opens into a
          prep view — you&rsquo;ll press <strong>START NET</strong> there when
          you&rsquo;re ready to go live.
        </p>

        {/* Mode chooser — three labelled radio chips. The active section is
            enabled; the other two visually fade and become non-interactive. */}
        <fieldset className="hna-topic-mode">
          <legend>Topic source</legend>
          <label
            className="hna-topic-mode__option"
            data-selected={mode === 'none'}
          >
            <input
              type="radio"
              name={modeGroupName}
              value="none"
              checked={mode === 'none'}
              onChange={() => setMode('none')}
            />
            <span>No topic</span>
          </label>
          <label
            className="hna-topic-mode__option"
            data-selected={mode === 'suggested'}
          >
            <input
              type="radio"
              name={modeGroupName}
              value="suggested"
              checked={mode === 'suggested'}
              onChange={() => setMode('suggested')}
            />
            <span>Suggested topic</span>
          </label>
          <label
            className="hna-topic-mode__option"
            data-selected={mode === 'custom'}
          >
            <input
              type="radio"
              name={modeGroupName}
              value="custom"
              checked={mode === 'custom'}
              onChange={() => setMode('custom')}
            />
            <span>New topic</span>
          </label>
        </fieldset>

        {/* Suggested-topic section. Disabled (greyed + click-blocked) when the
            mode chooser points elsewhere. */}
        <fieldset
          className="hna-topic-section"
          aria-disabled={mode !== 'suggested'}
        >
          <legend>Suggested topics</legend>
          {topics.length === 0 && (
            <div style={{ color: 'var(--color-fg-muted)', fontSize: 13 }}>
              No open topic suggestions.
            </div>
          )}
          {topics.map((t) => (
            <label
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: 4,
              }}
            >
              <input
                type="radio"
                name={suggestedGroupName}
                value={t.id}
                checked={selected === t.id}
                onChange={() => setSelected(t.id)}
                disabled={mode !== 'suggested'}
              />
              <span>{t.title}</span>
            </label>
          ))}
        </fieldset>

        {/* New-topic text input. Mirrors the styling of the radio block so the
            two are clearly parallel choices. */}
        <fieldset
          className="hna-topic-section"
          aria-disabled={mode !== 'custom'}
        >
          <legend>Or enter a new topic</legend>
          <label htmlFor={customInputId} className="hna-label">
            New topic title
          </label>
          <Input
            id={customInputId}
            value={customTitle}
            onChange={(e) => setCustomTitle(e.target.value)}
            placeholder="e.g. Field Day planning"
            disabled={mode !== 'custom'}
          />
        </fieldset>

        {err && (
          <div
            role="alert"
            className="hna-form-error"
            style={{ marginTop: 4 }}
          >
            {err}
          </div>
        )}
        <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? 'Opening…' : 'Open net'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
