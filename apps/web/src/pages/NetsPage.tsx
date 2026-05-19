import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Net, NetInput, NetSession, Repeater, ScriptCategory } from '@hna/shared';
import { apiFetch } from '../api/client.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { Button } from '../components/ui/Button.js';
import { Card } from '../components/ui/Card.js';
import { StartNetModal } from '../components/StartNetModal.js';
import {
  NetEditModal,
  emptyNetInput,
  netToInput,
} from '../components/NetEditModal.js';
import { useAuth } from '../auth/AuthProvider.js';
import { dayName, formatStartLocal12h } from '../lib/time.js';

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
  const [categoryFilter, setCategoryFilter] = useState<ScriptCategory | 'all'>('all');

  async function takeControl(sessionId: string) {
    await apiFetch(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ controlOpId: user!.id }),
    });
    nav(`/run/${sessionId}`);
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
                  data: {
                    ...emptyNetInput,
                    repeaterId: repeaters[0]?.id ?? '',
                  },
                })
              }
            >
              Add net
            </Button>
          )}
        </div>
      </div>
      <div className="hna-field" style={{ marginTop: 16, maxWidth: 260 }}>
        <label>Filter by script category</label>
        <select
          className="hna-input"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as ScriptCategory | 'all')}
        >
          <option value="all">All categories</option>
          <option value="weekly">Weekly</option>
          <option value="general">General</option>
          <option value="impromptu">Impromptu</option>
        </select>
      </div>
      {(['weekly', 'impromptu'] as const).map((kind) => {
        const group = nets.filter(
          (n) =>
            (n.kind ?? 'weekly') === kind &&
            (categoryFilter === 'all' ||
              (n.scriptCategory ?? 'general') === categoryFilter),
        );
        if (group.length === 0) return null;
        return (
          <div key={kind}>
            <h2 style={{ marginTop: 24, marginBottom: 0, fontSize: 16, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
              {kind === 'weekly' ? 'Weekly nets' : 'Impromptu nets'}
            </h2>
            <div style={{ display: 'grid', gap: 16, marginTop: 12 }}>
        {group.map((n) => (
          <Card key={n.id}>
            <div className="hna-flex-wrap" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {n.name}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      padding: '2px 6px',
                      borderRadius: 4,
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {n.kind === 'impromptu' ? 'Impromptu' : 'Weekly'}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      padding: '2px 6px',
                      borderRadius: 4,
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    Script: {SCRIPT_CATEGORY_LABELS[n.scriptCategory ?? 'general']}
                  </span>
                </h3>
                {n.kind === 'impromptu' ? (
                  <div style={{ color: 'var(--color-text-muted)' }}>Ad-hoc — no fixed schedule</div>
                ) : (
                  <div>
                    {dayName(n.dayOfWeek)} at {formatStartLocal12h(n.startLocal)} ({n.timezone})
                  </div>
                )}
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
                    onClick={() => setEditing({ id: n.id, data: netToInput(n) })}
                  >
                    Edit
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
            </div>
          </div>
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
