import React, { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Net, NetInput, NetSession, Repeater, ScriptCategory } from '@hna/shared';
import { roleAtLeast } from '@hna/shared';
import { apiFetch, errorMessage } from '../api/client.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { Button } from '../components/ui/Button.js';
import { Card } from '../components/ui/Card.js';
import { LiveDot } from '../components/ui/LiveDot.js';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { StartNetModal } from '../components/StartNetModal.js';
import {
  NetEditModal,
  emptyNetInput,
  netToInput,
} from '../components/NetEditModal.js';
import { useAuth } from '../auth/AuthProvider.js';
import { dayName, formatStartLocal12h } from '../lib/time.js';
import { formatReminderMinutes } from '../lib/reminders.js';

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

const SCRIPT_CATEGORY_LABELS: Record<ScriptCategory, string> = {
  weekly: 'Weekly',
  general: 'General',
  impromptu: 'Impromptu',
};

function NetCard({
  n,
  active,
  canRun,
  canManage,
  onStart,
  onTake,
  onEdit,
  onJoin,
}: {
  n: NetWithRepeater;
  active?: { id: string; controlOpId: string | null };
  // canRun: run-the-net authority (open/start a session, take control) —
  // NET_CONTROL+. canManage: club-config authority (edit the net) — OFFICER+.
  canRun: boolean;
  canManage: boolean;
  onStart: (id: string, name: string) => void;
  onTake: (sessionId: string) => void;
  onEdit: (n: NetWithRepeater) => void;
  onJoin: (netId: string) => void;
}) {
  const reminderText = formatReminderMinutes(n.reminderMinutes);
  return (
    <Card>
      <div className="hna-net-row">
        <div className="hna-net-row__when">
          {n.kind === 'impromptu' ? (
            <span className="hna-net-row__schedule">AD-HOC</span>
          ) : (
            <span className="hna-net-row__schedule">
              {dayName(n.dayOfWeek).toUpperCase()}{' '}
              {formatStartLocal12h(n.startLocal)}
            </span>
          )}
          <span className="hna-net-row__name">{n.name}</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <span className="hna-chip">
              {n.kind === 'impromptu' ? 'Impromptu' : 'Weekly'}
            </span>
            <span className="hna-chip">
              Script: {SCRIPT_CATEGORY_LABELS[n.scriptCategory ?? 'general']}
            </span>
            {n.kind !== 'impromptu' && (
              <span
                className={`hna-chip ${reminderText === 'off' ? 'hna-chip--off' : ''}`}
              >
                RMD: {reminderText}
              </span>
            )}
            {active && (
              <span
                className="hna-chip hna-chip--accent"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <LiveDot label="Live" /> LIVE
              </span>
            )}
          </div>
        </div>
        <div className="hna-net-row__meta">
          <span className="hna-net-row__freq">
            {n.repeater.frequency.toFixed(3)} MHz
          </span>
          <span className="hna-net-row__sub">{n.repeater.name}</span>
          {n.links && n.links.length > 0 && (
            <span className="hna-net-row__sub">
              + {n.links.length} linked
              {n.links.length > 1 ? ' repeaters' : ' repeater'}
            </span>
          )}
          {n.kind !== 'impromptu' && (
            <span className="hna-mono" style={{ fontSize: 11, color: 'var(--color-fg-muted)', letterSpacing: '0.06em' }}>
              Reminders: {reminderText}
              {` · ${n.timezone}`}
            </span>
          )}
          {n.theme && (
            <span className="hna-net-row__sub">Theme: {n.theme}</span>
          )}
        </div>
        <div className="hna-net-row__actions">
          {canRun && !active && (
            <Button variant="primary" onClick={() => onStart(n.id, n.name)}>
              Open net
            </Button>
          )}
          {canRun && active && (
            <>
              <Button
                variant="primary"
                aria-describedby={`nets-take-control-help-${n.id}`}
                title="Transfer Net Control authority to yourself for this session."
                onClick={() => onTake(active.id)}
              >
                Take control
              </Button>
              {/* sr-only caption — matches Dashboard / RunNet pattern. */}
              <span
                id={`nets-take-control-help-${n.id}`}
                className="sr-only"
              >
                Transfer Net Control authority to yourself for this session.
              </span>
            </>
          )}
          {active && (
            <Button variant="secondary" onClick={() => onJoin(n.id)}>
              Join net
            </Button>
          )}
          {canManage && (
            <Button variant="secondary" onClick={() => onEdit(n)}>
              Edit
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export function NetsPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  // canRunNet: open/start a session, take control (run-the-net) — NET_CONTROL+.
  // canManageNet: add / edit nets and manage repeaters (config) — OFFICER+.
  const canRunNet = !!user && roleAtLeast(user.role, 'NET_CONTROL');
  const canManageNet = !!user && roleAtLeast(user.role, 'OFFICER');
  const filterId = useId();
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
  const [categoryFilter, setCategoryFilter] = useState<ScriptCategory | 'all'>('all');

  function openAddNet() {
    setEditing({
      data: {
        ...emptyNetInput,
        repeaterId: repeaters[0]?.id ?? '',
      },
    });
  }

  const visibleByKind = (['weekly', 'impromptu'] as const).map((kind) =>
    nets.filter(
      (n) =>
        (n.kind ?? 'weekly') === kind &&
        (categoryFilter === 'all' ||
          (n.scriptCategory ?? 'general') === categoryFilter),
    ),
  );
  const allEmpty = visibleByKind.every((g) => g.length === 0);

  const [takingControl, setTakingControl] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  async function takeControl(sessionId: string) {
    // Guard re-entry so a double-click can't fire two racing PATCHes, and
    // surface a failure instead of leaving a dead-looking button.
    if (takingControl) return;
    setTakingControl(true);
    setActionErr(null);
    try {
      await apiFetch(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ controlOpId: user!.id }),
      });
      nav(`/run/${sessionId}`);
    } catch (e) {
      setActionErr(errorMessage(e));
      setTakingControl(false);
    }
  }

  function openStart(id: string, name: string) {
    setStarting({ id, name });
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <header className="hna-page-header">
        <p className="hna-page-marker">// 02 — NETS</p>
        <h1 className="hna-page-title">Nets</h1>
        <p className="hna-page-sub">
          Weekly schedule and impromptu nets. Net Control operators can open a
          session; officers can also add and edit nets.
        </p>
      </header>

      {actionErr && (
        <p className="hna-input-error" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
          {actionErr}
        </p>
      )}

      <div className="hna-toolbar">
        <div className="hna-toolbar__filter">
          <label htmlFor={filterId}>Filter by script category</label>
          <select
            id={filterId}
            className="hna-input"
            value={categoryFilter}
            onChange={(e) =>
              setCategoryFilter(e.target.value as ScriptCategory | 'all')
            }
          >
            <option value="all">All categories</option>
            <option value="weekly">Weekly</option>
            <option value="general">General</option>
            <option value="impromptu">Impromptu</option>
          </select>
        </div>
        <div className="hna-toolbar__spacer" />
        <div className="hna-toolbar__actions">
          {canManageNet && (
            <Button variant="secondary" onClick={() => nav('/repeaters')}>
              Manage repeaters
            </Button>
          )}
          {canManageNet && (
            <Button variant="primary" onClick={openAddNet}>
              Add net
            </Button>
          )}
        </div>
      </div>

      {allEmpty && (
        <section aria-label="No nets" style={{ marginBottom: 24 }}>
          <p className="hna-cap">[ NO NETS ]</p>
          <Card>
            {canManageNet ? (
              <div className="hna-empty">
                <p className="hna-empty__title">No nets yet</p>
                <p className="hna-empty__body">
                  Create your club&apos;s first weekly net — pick a repeater, a
                  day, and a time.
                </p>
                <div className="hna-empty__actions">
                  <Button variant="primary" onClick={openAddNet}>
                    Add your first net
                  </Button>
                </div>
              </div>
            ) : (
              <div className="hna-empty">
                <p className="hna-empty__title">No nets scheduled</p>
                <p className="hna-empty__body">
                  No nets are scheduled yet. Ask a club officer to add one.
                </p>
              </div>
            )}
          </Card>
        </section>
      )}

      {(['weekly', 'impromptu'] as const).map((kind, idx) => {
        const group = visibleByKind[idx]!;
        if (group.length === 0) return null;
        const isFirst = idx === 0;
        const label = kind === 'weekly' ? 'WEEKLY' : 'IMPROMPTU';
        return (
          <section key={kind} aria-label={`${label} nets`}>
            {isFirst ? (
              <h2 className="hna-cap hna-cap--accent">[ {label} ]</h2>
            ) : (
              <SectionDivider>{label}</SectionDivider>
            )}
            <div className="hna-stack">
              {group.map((n) => (
                <NetCard
                  key={n.id}
                  n={n}
                  active={activeByNetId[n.id]}
                  canRun={canRunNet}
                  canManage={canManageNet}
                  onStart={openStart}
                  onTake={takeControl}
                  onEdit={(net) =>
                    setEditing({ id: net.id, data: netToInput(net) })
                  }
                  onJoin={(netId) => nav(`/nets/${netId}/join`)}
                />
              ))}
            </div>
          </section>
        );
      })}

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
      {editing && (
        <NetEditModal
          open
          netId={editing.id}
          initial={editing.data}
          repeaters={repeaters}
          onClose={() => setEditing(null)}
          onSaved={refreshNets}
        />
      )}
    </div>
  );
}
