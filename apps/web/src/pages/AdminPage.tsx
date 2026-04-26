import React, { useEffect, useState } from 'react';
import type { PublicUser, Role } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { displayCallsign } from '../lib/format.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { LogImportModal } from '../components/LogImportModal.js';

interface TrashSession {
  id: string;
  netId: string;
  netName: string;
  startedAt: string;
  endedAt: string | null;
  deletedAt: string | null;
  topic: string | null;
  controlOp: { callsign: string; name: string } | null;
  checkInCount: number;
}

interface TrashCheckIn {
  id: string;
  sessionId: string;
  netName: string;
  callsign: string;
  nameAtCheckIn: string;
  checkedInAt: string;
  deletedAt: string | null;
}

interface TrashPayload {
  sessions: TrashSession[];
  checkIns: TrashCheckIn[];
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AdminPage() {
  const { user: currentUser } = useAuth();
  const { all: allThemes } = useTheme();
  const { data: users, refresh } = useAutoFetch<PublicUser[]>('/users', {
    intervalMs: 5000,
  });
  const { data: trash, refresh: refreshTrash } = useAutoFetch<TrashPayload>('/admin/trash', {
    intervalMs: 15000,
  });
  const [defaultSlug, setDefaultSlug] = useState<string>('default');
  const [defaultSaved, setDefaultSaved] = useState<string | null>(null);
  const [logImportOpen, setLogImportOpen] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<{ slug: string }>('/themes/default', { signal: ctrl.signal })
      .then((r) => setDefaultSlug(r.slug))
      .catch((e) => {
        if (!isAbortError(e)) { /* ignore */ }
      });
    return () => ctrl.abort();
  }, []);

  async function setRole(id: string, role: Role) {
    await apiFetch(`/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
    await refresh();
  }

  async function deleteUser(u: PublicUser) {
    if (!window.confirm(`Delete user ${displayCallsign(u.callsign)} — ${u.name}? This cannot be undone.`)) {
      return;
    }
    await apiFetch(`/users/${u.id}`, { method: 'DELETE' });
    await refresh();
  }

  async function setUserTheme(id: string, slug: string) {
    await apiFetch(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ collegeSlug: slug === '' ? null : slug }),
    });
    await refresh();
  }

  async function restoreSession(id: string) {
    await apiFetch(`/admin/trash/sessions/${id}/restore`, { method: 'POST' });
    await refreshTrash();
  }
  async function restoreCheckIn(id: string) {
    const res = await apiFetch<{ ok: boolean; parentSoftDeleted: boolean }>(
      `/admin/trash/checkins/${id}/restore`,
      { method: 'POST' },
    );
    if (res.parentSoftDeleted) {
      window.alert(
        'Check-in restored, but its session is still in the trash. Restore the session to see it.',
      );
    }
    await refreshTrash();
  }
  async function purgeSession(s: TrashSession) {
    if (!window.confirm(
      `Permanently delete the session for ${s.netName} started ${formatWhen(s.startedAt)}? This cannot be undone.`,
    )) return;
    await apiFetch(`/admin/trash/sessions/${s.id}`, { method: 'DELETE' });
    await refreshTrash();
  }
  async function purgeCheckIn(c: TrashCheckIn) {
    if (!window.confirm(
      `Permanently delete the check-in ${displayCallsign(c.callsign)} — ${c.nameAtCheckIn}? This cannot be undone.`,
    )) return;
    await apiFetch(`/admin/trash/checkins/${c.id}`, { method: 'DELETE' });
    await refreshTrash();
  }

  async function saveDefaultTheme() {
    const res = await apiFetch<{ slug: string }>('/themes/default', {
      method: 'PATCH',
      body: JSON.stringify({ slug: defaultSlug }),
    });
    setDefaultSlug(res.slug);
    setDefaultSaved(res.slug);
    window.setTimeout(() => setDefaultSaved(null), 2000);
  }

  return (
    <div className="hna-container" style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1>Admin</h1>
      <Card>
        <h3>Default theme for new users</h3>
        <p style={{ fontSize: 13, opacity: 0.8 }}>
          New accounts will start on this theme. Existing users keep their current choice.
        </p>
        <div className="hna-flex-wrap" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <select
            value={defaultSlug}
            onChange={(e) => setDefaultSlug(e.target.value)}
          >
            {allThemes.map((t) => (
              <option key={t.slug} value={t.slug}>{t.shortName ?? t.name}</option>
            ))}
          </select>
          <Button onClick={saveDefaultTheme}>Save</Button>
          {defaultSaved && (
            <span style={{ color: 'var(--color-success)' }}>Saved ({defaultSaved})</span>
          )}
        </div>
      </Card>
      <div style={{ height: 16 }} />
      <Card>
        <h3>Tools</h3>
        <p style={{ fontSize: 13, opacity: 0.8 }}>
          Bulk-import historical net logs from a Google Doc or pasted text.
          Sessions are attached to a Net you choose, with check-ins linked
          to existing members by callsign.
        </p>
        <Button onClick={() => setLogImportOpen(true)}>Import historical logs</Button>
      </Card>
      <div style={{ height: 16 }} />
      <Card>
        <h3>Members</h3>
        {users === null && <p>Loading…</p>}
        <div className="hna-table-scroll">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Callsign</th>
              <th align="left">Name</th>
              <th align="left">Email</th>
              <th align="left">Role</th>
              <th align="left">Theme</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td><span className="hna-callsign">{displayCallsign(u.callsign)}</span></td>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>
                  <select
                    value={u.collegeSlug ?? ''}
                    onChange={(e) => setUserTheme(u.id, e.target.value)}
                  >
                    <option value="">(default)</option>
                    {allThemes.map((t) => (
                      <option key={t.slug} value={t.slug}>{t.shortName ?? t.name}</option>
                    ))}
                  </select>
                </td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['MEMBER', 'OFFICER', 'ADMIN'] as Role[])
                    .filter((r) => r !== u.role)
                    .map((r) => (
                      <Button key={r} variant="secondary" onClick={() => setRole(u.id, r)}>
                        Make {r.toLowerCase()}
                      </Button>
                    ))}
                  {currentUser && u.id !== currentUser.id && (
                    <Button variant="danger" onClick={() => deleteUser(u)}>
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>
      {trash && (trash.sessions.length > 0 || trash.checkIns.length > 0) && (
        <>
          <div style={{ height: 16 }} />
          <Card>
            <h3>Recently deleted</h3>
            <p style={{ fontSize: 13, opacity: 0.8 }}>
              Items deleted in the last 30 days. Restore to undo, or remove permanently.
            </p>
            <div className="hna-table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">Type</th>
                  <th align="left">Description</th>
                  <th align="left">Deleted at</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {trash.sessions.map((s) => (
                  <tr key={`s-${s.id}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td>Session</td>
                    <td>
                      {s.netName} — started {formatWhen(s.startedAt)}
                      {s.topic ? ` (${s.topic})` : ''}
                      {s.checkInCount > 0 ? ` · ${s.checkInCount} check-in(s)` : ''}
                    </td>
                    <td>{formatWhen(s.deletedAt)}</td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Button variant="secondary" onClick={() => restoreSession(s.id)}>
                        Restore
                      </Button>
                      <Button variant="danger" onClick={() => purgeSession(s)}>
                        Delete forever
                      </Button>
                    </td>
                  </tr>
                ))}
                {trash.checkIns.map((c) => (
                  <tr key={`c-${c.id}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td>Check-in</td>
                    <td>
                      <span className="hna-callsign">{displayCallsign(c.callsign)}</span>
                      {' — '}{c.nameAtCheckIn} in {c.netName}
                    </td>
                    <td>{formatWhen(c.deletedAt)}</td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Button variant="secondary" onClick={() => restoreCheckIn(c.id)}>
                        Restore
                      </Button>
                      <Button variant="danger" onClick={() => purgeCheckIn(c)}>
                        Delete forever
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </Card>
        </>
      )}
      <LogImportModal
        open={logImportOpen}
        onClose={() => setLogImportOpen(false)}
        onImported={() => { /* nothing else needed */ }}
      />
    </div>
  );
}
