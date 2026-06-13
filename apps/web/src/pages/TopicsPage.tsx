import React, { useId, useState } from 'react';
import type { TopicSuggestion, TopicStatus } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { ConfirmModal } from '../components/ui/ConfirmModal.js';
import { useAuth } from '../auth/AuthProvider.js';
import { displayCallsign } from '../lib/format.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';

function StatusChip({ status }: { status: TopicStatus }) {
  const cls = status === 'OPEN' ? 'hna-chip hna-chip--accent' : 'hna-chip hna-chip--off';
  return <span className={cls}>{status}</span>;
}

/**
 * Topic suggestions — calibrated form Card up top, then a vertical stack of
 * topic Cards. Status is rendered with the calibrated `hna-chip` vocabulary
 * (accent for OPEN, off for USED/DISMISSED) so the page reads like the rest
 * of the console; the empty state preserves the exact copy that the Batch-1
 * audit landed on.
 */
export function TopicsPage() {
  const { user } = useAuth();
  const { data: topicsData, refresh } = useAutoFetch<TopicSuggestion[]>(
    '/topics',
    { intervalMs: 10000 },
  );
  const topics = topicsData ?? [];
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TopicSuggestion | null>(null);

  const isOfficer = user?.role === 'OFFICER' || user?.role === 'ADMIN';
  const titleId = useId();
  const detailsId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (title.trim().length < 3) {
      setErr('Title must be at least 3 characters.');
      return;
    }
    setLoading(true);
    try {
      await apiFetch('/topics', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          details: details.trim() || null,
        }),
      });
      setTitle('');
      setDetails('');
      await refresh();
    } catch (ex) {
      if (ex instanceof ApiErrorException) setErr(ex.payload.message);
      else setErr('Failed to submit topic');
    } finally {
      setLoading(false);
    }
  }

  async function setStatus(id: string, status: TopicStatus) {
    await apiFetch(`/topics/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await refresh();
  }

  async function performDelete() {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    setConfirmDelete(null);
    await apiFetch(`/topics/${id}`, { method: 'DELETE' });
    await refresh();
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <header className="hna-page-header">
        <p className="hna-page-marker">// 05 — TOPICS</p>
        <h1 className="hna-page-title">Topics</h1>
        <p className="hna-page-sub">
          Suggest a net theme. Officers mark suggestions used after they
          air them; the submitter can withdraw an OPEN suggestion at any
          time.
        </p>
      </header>

      <p className="hna-cap hna-cap--accent">[ SUGGEST ]</p>
      <Card>
        <form onSubmit={submit} className="hna-form">
          <div className="hna-field">
            <label htmlFor={titleId}>Title</label>
            <Input
              id={titleId}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Grounding best practices"
              required
            />
          </div>
          <div className="hna-field">
            <label htmlFor={detailsId}>Details (optional)</label>
            <textarea
              id={detailsId}
              rows={4}
              className="hna-input"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Why is this a good topic? Any links or references?"
            />
          </div>
          {err && (
            <p role="alert" className="hna-input-error">
              {err}
            </p>
          )}
          <div>
            <Button type="submit" disabled={loading}>
              {loading ? 'Submitting…' : 'Suggest'}
            </Button>
          </div>
        </form>
      </Card>

      <p className="hna-cap" style={{ marginTop: 'var(--space-5)' }}>
        [ SUGGESTIONS ]
      </p>
      <div className="hna-stack">
        {topics.length === 0 && (
          <Card>
            <div className="hna-empty">
              <p className="hna-empty__title">No topic suggestions yet</p>
              <p className="hna-empty__body">
                Propose one with the form above.
              </p>
            </div>
          </Card>
        )}
        {topics.map((t) => {
          const mine = user && t.createdById === user.id;
          const canDelete = isOfficer || (mine && t.status === 'OPEN');
          return (
            <Card key={t.id}>
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
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                    }}
                  >
                    <h3
                      className="hna-display"
                      style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}
                    >
                      {t.title}
                    </h3>
                    <StatusChip status={t.status} />
                  </div>
                  <p
                    className="hna-mono"
                    style={{
                      margin: '6px 0 0',
                      fontSize: 11,
                      letterSpacing: '0.08em',
                      color: 'var(--color-fg-muted)',
                    }}
                  >
                    BY{' '}
                    {t.createdByCallsign ? (
                      <span style={{ color: 'var(--color-primary)', fontWeight: 700 }}>
                        {displayCallsign(t.createdByCallsign)}
                      </span>
                    ) : (
                      'UNKNOWN'
                    )}
                    {t.createdByName ? ` · ${t.createdByName}` : ''} ·{' '}
                    {new Date(t.createdAt).toLocaleString()}
                  </p>
                  {t.details && (
                    <p style={{ marginTop: 'var(--space-3)', whiteSpace: 'pre-wrap', fontSize: 14 }}>
                      {t.details}
                    </p>
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
                  {isOfficer && t.status === 'OPEN' && (
                    <Button variant="secondary" onClick={() => setStatus(t.id, 'USED')}>
                      Mark used
                    </Button>
                  )}
                  {isOfficer && t.status !== 'OPEN' && (
                    <Button variant="secondary" onClick={() => setStatus(t.id, 'OPEN')}>
                      Mark open
                    </Button>
                  )}
                  {isOfficer && t.status === 'OPEN' && (
                    <Button variant="ghost" onClick={() => setStatus(t.id, 'DISMISSED')}>
                      Dismiss
                    </Button>
                  )}
                  {canDelete && (
                    <Button variant="danger" onClick={() => setConfirmDelete(t)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <ConfirmModal
        open={confirmDelete !== null}
        title="Delete topic"
        message={
          confirmDelete
            ? `Remove the suggestion "${confirmDelete.title}"? This can't be undone.`
            : ''
        }
        confirmLabel="Remove"
        onConfirm={() => {
          void performDelete();
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
