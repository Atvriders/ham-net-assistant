import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Net, NetInput, Repeater } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Modal } from '../components/ui/Modal.js';
import { Card } from '../components/ui/Card.js';
import { useAuth } from '../auth/AuthProvider.js';
import { dayName } from '../lib/time.js';

interface NetWithRepeater extends Net {
  repeater: Repeater;
}

const empty: NetInput = {
  name: '',
  repeaterId: '',
  dayOfWeek: 3,
  startLocal: '20:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  theme: '',
  scriptMd: '',
  active: true,
};

export function NetsPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const canEdit = user?.role === 'OFFICER' || user?.role === 'ADMIN';
  const [nets, setNets] = useState<NetWithRepeater[]>([]);
  const [repeaters, setRepeaters] = useState<Repeater[]>([]);
  const [editing, setEditing] = useState<{ id?: string; data: NetInput } | null>(null);

  async function reload() {
    const [n, r] = await Promise.all([
      apiFetch<NetWithRepeater[]>('/nets'),
      apiFetch<Repeater[]>('/repeaters'),
    ]);
    setNets(n);
    setRepeaters(r);
  }
  useEffect(() => {
    void reload();
  }, []);

  async function save() {
    if (!editing) return;
    const { id, data } = editing;
    if (id) await apiFetch(`/nets/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    else await apiFetch('/nets', { method: 'POST', body: JSON.stringify(data) });
    setEditing(null);
    await reload();
  }

  async function startNet(id: string) {
    const s = await apiFetch<{ id: string }>(`/nets/${id}/sessions`, { method: 'POST' });
    nav(`/run/${s.id}`);
  }

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h1>Nets</h1>
        {canEdit && (
          <Button
            onClick={() =>
              setEditing({
                data: { ...empty, repeaterId: repeaters[0]?.id ?? '' },
              })
            }
          >
            Add net
          </Button>
        )}
      </div>
      <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
        {nets.map((n) => (
          <Card key={n.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: 0 }}>{n.name}</h3>
                <div>
                  {dayName(n.dayOfWeek)} at {n.startLocal} ({n.timezone})
                </div>
                <div>Repeater: {n.repeater.name}</div>
                {n.theme && <div>Theme: {n.theme}</div>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {canEdit && <Button onClick={() => startNet(n.id)}>Start net</Button>}
                {canEdit && (
                  <Button variant="secondary" onClick={() => setEditing({ id: n.id, data: n })}>
                    Edit
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Modal open={editing !== null} onClose={() => setEditing(null)}>
        {editing && (
          <div>
            <h2>{editing.id ? 'Edit net' : 'New net'}</h2>
            <label>
              Name
              <Input
                value={editing.data.name}
                onChange={(e) =>
                  setEditing({ ...editing, data: { ...editing.data, name: e.target.value } })
                }
              />
            </label>
            <label>
              Repeater
              <select
                value={editing.data.repeaterId}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, repeaterId: e.target.value },
                  })
                }
              >
                {repeaters.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Day of week
              <select
                value={editing.data.dayOfWeek}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, dayOfWeek: Number(e.target.value) },
                  })
                }
              >
                {Array.from({ length: 7 }, (_, i) => (
                  <option key={i} value={i}>
                    {dayName(i)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Start time (HH:mm)
              <Input
                value={editing.data.startLocal}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, startLocal: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Theme
              <Input
                value={editing.data.theme ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, theme: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Script (markdown)
              <textarea
                rows={10}
                className="hna-input"
                value={editing.data.scriptMd ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, scriptMd: e.target.value },
                  })
                }
              />
            </label>
            <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
              <Button onClick={save}>Save</Button>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
