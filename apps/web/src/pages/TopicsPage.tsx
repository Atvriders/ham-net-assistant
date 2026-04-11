import React, { useEffect, useState } from 'react';
import type { TopicSuggestion, TopicStatus } from '@hna/shared';
import { apiFetch, isAbortError, ApiErrorException } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { useAuth } from '../auth/AuthProvider.js';

function StatusBadge({ status }: { status: TopicStatus }) {
  const color =
    status === 'OPEN'
      ? 'var(--color-accent)'
      : status === 'USED'
        ? 'var(--color-success)'
        : 'var(--color-border)';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 8,
        background: color,
        color: 'var(--color-primary-fg)',
        fontSize: 12,
        fontWeight: 600,
        marginLeft: 8,
      }}
    >
      {status}
    </span>
  );
}

export function TopicsPage() {
  const { user } = useAuth();
  const [topics, setTopics] = useState<TopicSuggestion[]>([]);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isOfficer = user?.role === 'OFFICER' || user?.role === 'ADMIN';

  async function reload(signal?: AbortSignal) {
    const list = await apiFetch<TopicSuggestion[]>('/topics', { signal });
    setTopics(list);
  }

  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal).catch((e) => {
      if (!isAbortError(e)) console.warn('topics load failed', e);
    });
    return () => ctrl.abort();
  }, []);

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
      await reload();
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
    await reload();
  }

  async function del(id: string) {
    if (!confirm('Delete this topic?')) return;
    await apiFetch(`/topics/${id}`, { method: 'DELETE' });
    await reload();
  }

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <h1>Net topic suggestions</h1>
      <Card>
        <h3>Suggest a topic</h3>
        <form onSubmit={submit}>
          <label>
            Title
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Grounding best practices"
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Details (optional)
            <textarea
              rows={4}
              className="hna-input"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          {err && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 8 }}>
              {err}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <Button type="submit" disabled={loading}>
              {loading ? 'Submitting…' : 'Submit'}
            </Button>
          </div>
        </form>
      </Card>

      <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        {topics.length === 0 && <p>No topics suggested yet.</p>}
        {topics.map((t) => {
          const mine = user && t.createdById === user.id;
          const canDelete = isOfficer || (mine && t.status === 'OPEN');
          return (
            <Card key={t.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ flex: 1 }}>
                  <h3 style={{ margin: 0 }}>
                    {t.title}
                    <StatusBadge status={t.status} />
                  </h3>
                  <div style={{ fontSize: 12, color: 'var(--color-border)' }}>
                    by {t.createdByCallsign ?? 'unknown'}
                    {t.createdByName ? ` (${t.createdByName})` : ''} ·{' '}
                    {new Date(t.createdAt).toLocaleString()}
                  </div>
                  {t.details && (
                    <p style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{t.details}</p>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexDirection: 'column' }}>
                  {isOfficer && t.status === 'OPEN' && (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => setStatus(t.id, 'USED')}
                      >
                        Mark as used
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setStatus(t.id, 'DISMISSED')}
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
                  {canDelete && (
                    <Button variant="danger" onClick={() => del(t.id)}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
