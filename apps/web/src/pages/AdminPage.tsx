import React, { useEffect, useState } from 'react';
import type { PublicUser, Role } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { displayCallsign } from '../lib/format.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';

export function AdminPage() {
  const { user: currentUser } = useAuth();
  const { all: allThemes } = useTheme();
  const { data: users, refresh } = useAutoFetch<PublicUser[]>('/users', {
    intervalMs: 5000,
  });
  const [defaultSlug, setDefaultSlug] = useState<string>('default');
  const [defaultSaved, setDefaultSaved] = useState<string | null>(null);

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
    </div>
  );
}
