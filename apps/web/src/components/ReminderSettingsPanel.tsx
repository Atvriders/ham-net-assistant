import React, { useMemo, useState } from 'react';
import type { Net, NetInput, Repeater } from '@hna/shared';
import { DEFAULT_REMINDER_MINUTES } from '@hna/shared';
import { apiFetch, errorMessage } from '../api/client.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Card } from './ui/Card.js';
import { Button } from './ui/Button.js';
import { NetEditModal, netToInput } from './NetEditModal.js';
import type { NetWithRepeater } from './NetEditModal.js';
import { dayName, formatStartLocal12h } from '../lib/time.js';
import { formatReminderMinutes } from '../lib/reminders.js';

interface NetLinkWithRepeater {
  id: string;
  repeaterId: string;
  repeater: Repeater;
  note?: string | null;
}

interface NetRow extends Net {
  repeater: Repeater;
  links: NetLinkWithRepeater[];
}

/**
 * Centralized reminder settings: lists every WEEKLY net with a quick
 * on/off toggle for reminders, plus a "Customize" affordance that opens
 * the shared NetEditModal so officers can fine-tune lead times without
 * leaving the panel. Impromptu nets are skipped (they don't fire
 * reminders). Officer+ gated; renders nothing for members.
 */
export function ReminderSettingsPanel() {
  const { user } = useAuth();
  const canEdit = user?.role === 'OFFICER' || user?.role === 'ADMIN';
  const { data: netsData, refresh: refreshNets } = useAutoFetch<NetRow[]>(
    canEdit ? '/nets' : null,
    { intervalMs: 30000 },
  );
  const { data: repeatersData } = useAutoFetch<Repeater[]>(
    canEdit ? '/repeaters' : null,
    { intervalMs: 60000 },
  );
  const [editing, setEditing] = useState<{ id: string; data: NetInput } | null>(
    null,
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [reminderErr, setReminderErr] = useState<string | null>(null);

  const weeklyNets = useMemo(() => {
    const all = netsData ?? [];
    return all
      .filter((n) => (n.kind ?? 'weekly') === 'weekly')
      .slice()
      .sort((a, b) => {
        if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
        return (a.startLocal ?? '').localeCompare(b.startLocal ?? '');
      });
  }, [netsData]);

  if (!canEdit) return null;

  async function setReminderMinutesForNet(net: NetRow, next: number[]) {
    setPendingId(net.id);
    setReminderErr(null);
    try {
      // PATCH /nets/:id validates against the full NetInput schema (name,
      // repeaterId, dayOfWeek, startLocal, timezone, …), so a partial body
      // with just reminderMinutes is rejected as 400. Send the existing net's
      // full input with the new reminderMinutes merged in.
      const input = netToInput(net as NetWithRepeater);
      await apiFetch(`/nets/${net.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...input, reminderMinutes: next }),
      });
      await refreshNets();
    } catch (e) {
      // Without this the switch just reverts on the next 30s poll with no word.
      setReminderErr(errorMessage(e));
    } finally {
      setPendingId(null);
    }
  }

  async function toggleReminders(net: NetRow, enabled: boolean) {
    if (enabled) {
      // Turning ON: if currently empty, seed with the default lead times;
      // otherwise leave any existing custom lead times alone.
      const current = Array.isArray(net.reminderMinutes)
        ? net.reminderMinutes
        : [];
      if (current.length > 0) return;
      await setReminderMinutesForNet(net, [...DEFAULT_REMINDER_MINUTES]);
    } else {
      await setReminderMinutesForNet(net, []);
    }
  }

  return (
    <>
      <Card>
        <h3>Reminder settings</h3>
        <p style={{ fontSize: 13, opacity: 0.8 }}>
          Quickly pick which weekly nets have reminders. Toggle a net on to
          schedule the default lead times ({formatReminderMinutes([...DEFAULT_REMINDER_MINUTES])}),
          or open Customize to fine-tune. Impromptu nets are skipped — they
          have no fixed schedule.
        </p>
        {reminderErr && (
          <p className="hna-input-error" role="alert">
            {reminderErr}
          </p>
        )}
        {netsData === null && <p>Loading…</p>}
        {netsData !== null && weeklyNets.length === 0 && (
          <p style={{ fontSize: 13, opacity: 0.7, fontStyle: 'italic' }}>
            No weekly nets configured yet.
          </p>
        )}
        {weeklyNets.length > 0 && (
          <div className="hna-table-scroll" style={{ overflowX: 'auto' }}>
            <table className="hna-log-table" style={{ minWidth: 600 }}>
              <caption className="sr-only">
                Reminder schedule per weekly net
              </caption>
              <thead>
                <tr>
                  <th scope="col">Net</th>
                  <th scope="col">When</th>
                  <th scope="col">Reminders</th>
                  <th scope="col">On</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {weeklyNets.map((n) => {
                  const mins = Array.isArray(n.reminderMinutes)
                    ? n.reminderMinutes
                    : [];
                  const isOn = mins.length > 0;
                  const isPending = pendingId === n.id;
                  return (
                    <tr key={n.id}>
                      <th scope="row" style={{ textAlign: 'left' }}>
                        <div className="hna-display" style={{ fontSize: 14 }}>
                          {n.name}
                        </div>
                        <div
                          className="hna-mono"
                          style={{
                            fontSize: 11,
                            letterSpacing: '0.06em',
                            color: 'var(--color-fg-muted)',
                            fontWeight: 400,
                          }}
                        >
                          {n.repeater?.name ?? '—'}
                        </div>
                      </th>
                      <td
                        className="hna-mono"
                        style={{ fontSize: 12, letterSpacing: '0.06em' }}
                      >
                        {dayName(n.dayOfWeek)}{' '}
                        {formatStartLocal12h(n.startLocal)}
                      </td>
                      <td
                        className="hna-mono"
                        style={{ fontSize: 12, color: 'var(--color-fg-muted)' }}
                      >
                        {formatReminderMinutes(mins)}
                      </td>
                      <td>
                        <span
                          className="hna-switch"
                          style={{
                            cursor: isPending ? 'wait' : 'pointer',
                            opacity: isPending ? 0.6 : 1,
                          }}
                        >
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label={`Reminders for ${n.name}`}
                            checked={isOn}
                            disabled={isPending}
                            onChange={(e) =>
                              void toggleReminders(n, e.target.checked)
                            }
                          />
                          <span className="hna-switch__track" aria-hidden="true" />
                          <span className="hna-switch__thumb" aria-hidden="true" />
                        </span>
                      </td>
                      <td>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setEditing({
                              id: n.id,
                              data: netToInput(n as NetWithRepeater),
                            })
                          }
                        >
                          Customize
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && (
        <NetEditModal
          open
          netId={editing.id}
          initial={editing.data}
          repeaters={repeatersData ?? []}
          onClose={() => setEditing(null)}
          onSaved={refreshNets}
        />
      )}
    </>
  );
}
