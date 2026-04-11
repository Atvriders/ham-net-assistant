import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Net, NetInput, Repeater } from '@hna/shared';
import { apiFetch, isAbortError } from '../api/client.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Modal } from '../components/ui/Modal.js';
import { Card } from '../components/ui/Card.js';
import { StartNetModal } from '../components/StartNetModal.js';
import { useAuth } from '../auth/AuthProvider.js';
import { dayName, to12h, to24h, formatStartLocal12h } from '../lib/time.js';

interface NetLinkWithRepeater {
  id: string;
  repeaterId: string;
  repeater: Repeater;
  note?: string | null;
}
interface NetWithRepeater extends Net {
  repeater: Repeater;
  links: NetLinkWithRepeater[];
}

function toNetInput(n: NetWithRepeater): NetInput {
  return {
    name: n.name,
    repeaterId: n.repeaterId,
    dayOfWeek: n.dayOfWeek,
    startLocal: n.startLocal,
    timezone: n.timezone,
    theme: n.theme ?? null,
    scriptMd: n.scriptMd ?? null,
    active: n.active,
    linkedRepeaterIds: (n.links ?? []).map((l) => l.repeaterId),
  };
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
  linkedRepeaterIds: [],
};

export function NetsPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const canEdit = user?.role === 'OFFICER' || user?.role === 'ADMIN';
  const [nets, setNets] = useState<NetWithRepeater[]>([]);
  const [repeaters, setRepeaters] = useState<Repeater[]>([]);
  const [editing, setEditing] = useState<{ id?: string; data: NetInput } | null>(null);
  const [starting, setStarting] = useState<{ id: string; name: string } | null>(null);

  async function reload(signal?: AbortSignal) {
    const [n, r] = await Promise.all([
      apiFetch<NetWithRepeater[]>('/nets', { signal }),
      apiFetch<Repeater[]>('/repeaters', { signal }),
    ]);
    setNets(n);
    setRepeaters(r);
  }
  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal).catch((e) => {
      if (!isAbortError(e)) throw e;
    });
    return () => ctrl.abort();
  }, []);

  async function save() {
    if (!editing) return;
    const { id, data } = editing;
    if (id) await apiFetch(`/nets/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    else await apiFetch('/nets', { method: 'POST', body: JSON.stringify(data) });
    setEditing(null);
    await reload();
  }

  function openStart(id: string, name: string) {
    setStarting({ id, name });
  }

  return (
    <div className="hna-container" style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div className="hna-flex-wrap" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
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
            <div className="hna-flex-wrap" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div>
                <h3 style={{ margin: 0 }}>{n.name}</h3>
                <div>
                  {dayName(n.dayOfWeek)} at {formatStartLocal12h(n.startLocal)} ({n.timezone})
                </div>
                <div>Repeater: {n.repeater.name}</div>
                {n.links && n.links.length > 0 && (
                  <div>
                    Links:{' '}
                    {n.links
                      .map((l) => `${l.repeater.name} ${l.repeater.frequency.toFixed(2)}`)
                      .join(', ')}
                  </div>
                )}
                {n.theme && <div>Theme: {n.theme}</div>}
              </div>
              <div className="hna-flex-wrap" style={{ display: 'flex', gap: 8 }}>
                {canEdit && <Button onClick={() => openStart(n.id, n.name)}>Start net</Button>}
                {canEdit && (
                  <Button
                    variant="secondary"
                    onClick={() => setEditing({ id: n.id, data: toNetInput(n) })}
                  >
                    Edit
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {starting && (
        <StartNetModal
          open={starting !== null}
          netId={starting.id}
          netName={starting.name}
          onClose={() => setStarting(null)}
          onStarted={(sessionId) => {
            setStarting(null);
            nav(`/run/${sessionId}`);
          }}
        />
      )}
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
            <label>Linked repeaters (optional)</label>
            <div
              style={{
                maxHeight: 180,
                overflowY: 'auto',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                padding: 8,
              }}
            >
              {repeaters
                .filter((r) => r.id !== editing.data.repeaterId)
                .map((r) => (
                  <label
                    key={r.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 4 }}
                  >
                    <input
                      type="checkbox"
                      checked={(editing.data.linkedRepeaterIds ?? []).includes(r.id)}
                      onChange={(e) => {
                        const current = editing.data.linkedRepeaterIds ?? [];
                        const next = e.target.checked
                          ? [...current, r.id]
                          : current.filter((id) => id !== r.id);
                        setEditing({
                          ...editing,
                          data: { ...editing.data, linkedRepeaterIds: next },
                        });
                      }}
                    />
                    <span>
                      {r.name} — {r.frequency.toFixed(3)} MHz
                    </span>
                  </label>
                ))}
            </div>
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
              Start time
              {(() => {
                const t = to12h(editing.data.startLocal);
                const updateTime = (patch: Partial<typeof t>) => {
                  const next = { ...t, ...patch };
                  setEditing({
                    ...editing,
                    data: { ...editing.data, startLocal: to24h(next) },
                  });
                };
                const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
                return (
                  <div className="hna-flex-wrap" style={{ display: 'flex', gap: 8 }}>
                    <select
                      value={t.hour}
                      onChange={(e) => updateTime({ hour: Number(e.target.value) })}
                    >
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    <select
                      value={minutes.includes(t.minute) ? t.minute : 0}
                      onChange={(e) => updateTime({ minute: Number(e.target.value) })}
                    >
                      {minutes.map((m) => (
                        <option key={m} value={m}>
                          {String(m).padStart(2, '0')}
                        </option>
                      ))}
                    </select>
                    <select
                      value={t.meridiem}
                      onChange={(e) =>
                        updateTime({ meridiem: e.target.value as 'AM' | 'PM' })
                      }
                    >
                      <option value="AM">AM</option>
                      <option value="PM">PM</option>
                    </select>
                  </div>
                );
              })()}
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
            <div className="hna-flex-wrap" style={{ marginTop: 16, display: 'flex', gap: 12 }}>
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
