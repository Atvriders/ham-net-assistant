import React, { useEffect, useState } from 'react';
import type { PublicUser, Role } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';

export function AdminPage() {
  const [users, setUsers] = useState<PublicUser[]>([]);

  async function reload(signal?: AbortSignal) {
    setUsers(await apiFetch<PublicUser[]>('/users', { signal }));
  }
  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal).catch((e) => {
      if (!isAbortError(e)) throw e;
    });
    return () => ctrl.abort();
  }, []);

  async function setRole(id: string, role: Role) {
    await apiFetch(`/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
    await reload();
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <h1>Admin</h1>
      <Card>
        <h3>Members</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Callsign</th>
              <th align="left">Name</th>
              <th align="left">Email</th>
              <th align="left">Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td>{u.callsign}</td>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  {(['MEMBER', 'OFFICER', 'ADMIN'] as Role[])
                    .filter((r) => r !== u.role)
                    .map((r) => (
                      <Button key={r} variant="secondary" onClick={() => setRole(u.id, r)}>
                        Make {r.toLowerCase()}
                      </Button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
