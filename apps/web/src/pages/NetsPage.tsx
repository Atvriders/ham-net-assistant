import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Net, NetInput, NetSession, Repeater } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
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

interface ActiveSessionRow extends NetSession {
  net: { id: string; name: string };
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
  const { data: netsData, refresh: refreshNets } = useAutoFetch<
    NetWithRepeater[]
  >('/nets', { intervalMs: 15000 });
  const { data: repeatersData } = useAutoFetch<Repeater[]>('/repeaters', {
    intervalMs: 15000,
  });
  const { data: activeData } = useAutoFetch<ActiveSessionRow[]>('/nets/active', {
    intervalMs: 5000,
  });
  const nets = netsData ?? [];
  const repeaters = repeatersData ?? [];
  const activeByNetId = useMemo(() => {
    const map: Record<string, { id: string; controlOpId: string | null }> = {};
    for (const s of activeData ?? []) map[s.netId] = { id: s.id, controlOpId: s.controlOpId };
    return map;
  }, [activeData]);
  const [editing, setEditing] = useState<{ id?: string; data: NetInput } | null>(null);
  const [starting, setStarting] = useState<{ id: string; name: string } | null>(null);

  async function takeControl(sessionId: string) {
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ controlOpId: user!.id }),
    });
    nav(`/run/${sessionId}`);
  }

  async function save() {
    if (!editing) return;
    const { id, data } = editing;
    if (id) await apiFetch(`/nets/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    else await apiFetch('/nets', { method: 'POST', body: JSON.stringify(data) });
    setEditing(null);
    await refreshNets();
  }

  function openStart(id: string, name: string) {
    setStarting({ id, name });
  }

  return (
    <div className="hna-container" style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div className="hna-flex-wrap" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <h1 style={{ margin: 0 }}>Nets</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {canEdit && (
            <Button variant="secondary" onClick={() => nav('/repeaters')}>
              Manage repeaters
            </Button>
          )}
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
                {(() => {
                  const active = activeByNetId[n.id];
                  return (
                    <>
                      {canEdit && !active && (
                        <Button onClick={() => openStart(n.id, n.name)}>Start net</Button>
                      )}
                      {canEdit && active && (
                        <Button onClick={() => takeControl(active.id)}>Take control</Button>
                      )}
                      {active && (
                        <Button variant="secondary" onClick={() => nav(`/nets/${n.id}/join`)}>
                          Join as member
                        </Button>
                      )}
                    </>
                  );
                })()}
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
            <h2 style={{ marginTop: 0 }}>{editing.id ? 'Edit net' : 'New net'}</h2>
            <div className="hna-form">
              <div className="hna-field">
                <label>Name</label>
                <Input
                  value={editing.data.name}
                  onChange={(e) =>
                    setEditing({ ...editing, data: { ...editing.data, name: e.target.value } })
                  }
                />
              </div>

              <div className="hna-field">
                <label>Primary repeater</label>
                <select
                  className="hna-input"
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
                      {r.name} — {r.frequency.toFixed(3)} MHz
                    </option>
                  ))}
                </select>
              </div>

              <div className="hna-field">
                <label>Linked repeaters (optional)</label>
                <div className="hna-checkbox-list">
                  {repeaters.filter((r) => r.id !== editing.data.repeaterId).length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>No other repeaters available.</div>
                  )}
                  {repeaters
                    .filter((r) => r.id !== editing.data.repeaterId)
                    .map((r) => {
                      const checked = (editing.data.linkedRepeaterIds ?? []).includes(r.id);
                      return (
                        <label key={r.id}>
                          <input
                            type="checkbox"
                            checked={checked}
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
                          <span>{r.name} — {r.frequency.toFixed(3)} MHz</span>
                        </label>
                      );
                    })}
                </div>
              </div>

              <div className="hna-field-row-2">
                <div className="hna-field">
                  <label>Day of week</label>
                  <select
                    className="hna-input"
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
                </div>
                <div className="hna-field">
                  <label>Start time</label>
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
                      <div className="hna-field-row">
                        <select
                          className="hna-input"
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
                          className="hna-input"
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
                          className="hna-input"
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
                </div>
              </div>

              <div className="hna-field">
                <label>Theme (this week's topic cue)</label>
                <Input
                  value={editing.data.theme ?? ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      data: { ...editing.data, theme: e.target.value },
                    })
                  }
                />
              </div>

              <div className="hna-field">
                <label>Script (markdown)</label>
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
                  style={{ minHeight: 180, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, lineHeight: 1.5, resize: 'vertical' }}
                />
              </div>
            </div>
            <div className="hna-modal-actions">
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
