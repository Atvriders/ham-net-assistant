import React, { useEffect, useState } from 'react';
import type { Net, NetInput, Repeater, ScriptCategory } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { Modal } from './ui/Modal.js';
import { ScriptImportModal } from './ScriptImportModal.js';
import { dayName, to12h, to24h } from '../lib/time.js';

interface NetLinkWithRepeater {
  id: string;
  repeaterId: string;
  repeater: Repeater;
  note?: string | null;
}
export interface NetWithRepeater extends Net {
  repeater: Repeater;
  links?: NetLinkWithRepeater[];
}

export function netToInput(n: NetWithRepeater): NetInput {
  return {
    name: n.name,
    kind: n.kind,
    repeaterId: n.repeaterId,
    dayOfWeek: n.dayOfWeek,
    startLocal: n.startLocal,
    timezone: n.timezone,
    theme: n.theme ?? null,
    scriptMd: n.scriptMd ?? null,
    scriptCategory: n.scriptCategory ?? 'general',
    active: n.active,
    linkedRepeaterIds: (n.links ?? []).map((l) => l.repeaterId),
  };
}

export const emptyNetInput: NetInput = {
  name: '',
  kind: 'weekly',
  repeaterId: '',
  dayOfWeek: 3,
  startLocal: '20:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  theme: '',
  scriptMd: '',
  scriptCategory: 'general',
  active: true,
  linkedRepeaterIds: [],
};

interface Props {
  /** Whether the modal is open. */
  open: boolean;
  /** Net id when editing an existing net; omit/undefined to create a new net. */
  netId?: string;
  /** Initial form values. */
  initial: NetInput;
  /** Optional preloaded repeaters; fetched on open when not supplied. */
  repeaters?: Repeater[];
  onClose: () => void;
  /** Called after a successful save (POST or PATCH). */
  onSaved: () => void | Promise<void>;
}

/**
 * Shared net create/edit modal. Extracted from NetsPage so other surfaces
 * (e.g. the running-net script panel) can offer the same edit affordance
 * without duplicating the form.
 */
export function NetEditModal({
  open,
  netId,
  initial,
  repeaters: repeatersProp,
  onClose,
  onSaved,
}: Props) {
  const [data, setData] = useState<NetInput>(initial);
  const [repeaters, setRepeaters] = useState<Repeater[]>(repeatersProp ?? []);
  const [scriptImportOpen, setScriptImportOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-seed the form whenever the modal (re)opens for a different net.
  useEffect(() => {
    if (open) setData(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, netId]);

  // Load repeaters when none were supplied by the parent.
  useEffect(() => {
    if (!open || repeatersProp) return;
    let cancelled = false;
    apiFetch<Repeater[]>('/repeaters')
      .then((rows) => {
        if (!cancelled) setRepeaters(rows);
      })
      .catch(() => {
        /* ignore — repeater list stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [open, repeatersProp]);

  useEffect(() => {
    if (repeatersProp) setRepeaters(repeatersProp);
  }, [repeatersProp]);

  async function save() {
    setSaving(true);
    try {
      if (netId) {
        await apiFetch(`/nets/${netId}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        });
      } else {
        await apiFetch('/nets', { method: 'POST', body: JSON.stringify(data) });
      }
      await onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose}>
        <div>
          <h2 style={{ marginTop: 0 }}>{netId ? 'Edit net' : 'New net'}</h2>
          <div className="hna-form">
            <div className="hna-field">
              <label>Name</label>
              <Input
                value={data.name}
                onChange={(e) => setData({ ...data, name: e.target.value })}
              />
            </div>

            <div className="hna-field">
              <label>Kind</label>
              <select
                className="hna-input"
                value={data.kind ?? 'weekly'}
                onChange={(e) =>
                  setData({
                    ...data,
                    kind: e.target.value as 'weekly' | 'impromptu',
                  })
                }
              >
                <option value="weekly">Weekly (scheduled)</option>
                <option value="impromptu">Impromptu (ad-hoc)</option>
              </select>
              {(data.kind ?? 'weekly') === 'impromptu' && (
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  Impromptu nets have no fixed schedule and are skipped by net
                  reminders.
                </div>
              )}
            </div>

            <div className="hna-field">
              <label>Primary repeater</label>
              <select
                className="hna-input"
                value={data.repeaterId}
                onChange={(e) =>
                  setData({ ...data, repeaterId: e.target.value })
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
                {repeaters.filter((r) => r.id !== data.repeaterId).length ===
                  0 && (
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    No other repeaters available.
                  </div>
                )}
                {repeaters
                  .filter((r) => r.id !== data.repeaterId)
                  .map((r) => {
                    const checked = (data.linkedRepeaterIds ?? []).includes(
                      r.id,
                    );
                    return (
                      <label key={r.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const current = data.linkedRepeaterIds ?? [];
                            const next = e.target.checked
                              ? [...current, r.id]
                              : current.filter((id) => id !== r.id);
                            setData({ ...data, linkedRepeaterIds: next });
                          }}
                        />
                        <span>
                          {r.name} — {r.frequency.toFixed(3)} MHz
                        </span>
                      </label>
                    );
                  })}
              </div>
            </div>

            {(data.kind ?? 'weekly') === 'weekly' && (
              <div className="hna-field-row-2">
                <div className="hna-field">
                  <label>Day of week</label>
                  <select
                    className="hna-input"
                    value={data.dayOfWeek}
                    onChange={(e) =>
                      setData({ ...data, dayOfWeek: Number(e.target.value) })
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
                    const t = to12h(data.startLocal ?? '20:00');
                    const updateTime = (patch: Partial<typeof t>) => {
                      const next = { ...t, ...patch };
                      setData({ ...data, startLocal: to24h(next) });
                    };
                    const minutes = [
                      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
                    ];
                    return (
                      <div className="hna-field-row">
                        <select
                          className="hna-input"
                          value={t.hour}
                          onChange={(e) =>
                            updateTime({ hour: Number(e.target.value) })
                          }
                        >
                          {Array.from({ length: 12 }, (_, i) => i + 1).map(
                            (h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ),
                          )}
                        </select>
                        <select
                          className="hna-input"
                          value={minutes.includes(t.minute) ? t.minute : 0}
                          onChange={(e) =>
                            updateTime({ minute: Number(e.target.value) })
                          }
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
                            updateTime({
                              meridiem: e.target.value as 'AM' | 'PM',
                            })
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
            )}

            <div className="hna-field">
              <label>Theme (this week&rsquo;s topic cue)</label>
              <Input
                value={data.theme ?? ''}
                onChange={(e) => setData({ ...data, theme: e.target.value })}
              />
            </div>

            <div className="hna-field">
              <label>Script category</label>
              <select
                className="hna-input"
                value={data.scriptCategory ?? 'general'}
                onChange={(e) =>
                  setData({
                    ...data,
                    scriptCategory: e.target.value as ScriptCategory,
                  })
                }
              >
                <option value="weekly">Weekly</option>
                <option value="general">General</option>
                <option value="impromptu">Impromptu</option>
              </select>
            </div>

            <div className="hna-field">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                }}
              >
                <label>Script (markdown)</label>
                <button
                  type="button"
                  onClick={() => setScriptImportOpen(true)}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--color-border)',
                    borderRadius: 4,
                    padding: '2px 8px',
                    cursor: 'pointer',
                    color: 'var(--color-fg)',
                    fontSize: 12,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                  }}
                >
                  Import…
                </button>
              </div>
              <textarea
                rows={10}
                className="hna-input"
                value={data.scriptMd ?? ''}
                onChange={(e) => setData({ ...data, scriptMd: e.target.value })}
                style={{
                  minHeight: 180,
                  fontFamily: 'ui-monospace, Menlo, monospace',
                  fontSize: 13,
                  lineHeight: 1.5,
                  resize: 'vertical',
                }}
              />
            </div>
          </div>
          <div className="hna-modal-actions">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
      <ScriptImportModal
        open={scriptImportOpen}
        onClose={() => setScriptImportOpen(false)}
        onImport={(md, mode) => {
          const current = data.scriptMd ?? '';
          const next =
            mode === 'replace'
              ? md
              : current
                ? `${current}\n\n${md}`
                : md;
          setData({ ...data, scriptMd: next });
        }}
      />
    </>
  );
}
