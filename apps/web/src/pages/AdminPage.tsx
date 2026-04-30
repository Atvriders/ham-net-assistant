import React, { useEffect, useState } from 'react';
import type { PublicUser, Role } from '@hna/shared';
import { apiFetch, isAbortError, ApiErrorException } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { displayCallsign } from '../lib/format.js';
import { to12h, to24h } from '../lib/time.js';
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

interface DuplicateSessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  topicTitle: string | null;
  controlOpCallsign: string | null;
  controlOpName: string | null;
  checkInCount: number;
}

interface DuplicateGroup {
  netId: string;
  netName: string;
  date: string;
  sessions: DuplicateSessionRow[];
}

interface DiscordConfig {
  enabled: boolean;
  channelId: string;
  tokenSet: boolean;
  tokenFromEnv: boolean;
  channelIdFromEnv: boolean;
  enabledFromEnv: boolean;
  reminderTimesOfDay: string[];
}

interface ReminderRow {
  hour: number;        // 1..12
  minute: number;      // 0..55 (5-min steps)
  meridiem: 'AM' | 'PM';
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
  const { data: dupes, refresh: refreshDupes } = useAutoFetch<DuplicateGroup[]>(
    '/admin/duplicate-sessions',
    { intervalMs: 30000 },
  );
  const [defaultSlug, setDefaultSlug] = useState<string>('default');
  const [defaultSaved, setDefaultSaved] = useState<string | null>(null);
  const [logImportOpen, setLogImportOpen] = useState(false);
  const [discordCfg, setDiscordCfg] = useState<DiscordConfig | null>(null);
  const [discordTokenInput, setDiscordTokenInput] = useState('');
  const [discordChannelInput, setDiscordChannelInput] = useState('');
  const [discordEnabledInput, setDiscordEnabledInput] = useState(false);
  const [discordLeadsRows, setDiscordLeadsRows] = useState<ReminderRow[]>([]);
  const [discordSaving, setDiscordSaving] = useState(false);
  const [discordSaved, setDiscordSaved] = useState(false);
  const [discordTestResult, setDiscordTestResult] = useState<string | null>(null);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<{ slug: string }>('/themes/default', { signal: ctrl.signal })
      .then((r) => setDefaultSlug(r.slug))
      .catch((e) => {
        if (!isAbortError(e)) { /* ignore */ }
      });
    return () => ctrl.abort();
  }, []);

  async function loadDiscord() {
    try {
      const cfg = await apiFetch<DiscordConfig>('/discord/config');
      setDiscordCfg(cfg);
      setDiscordChannelInput(cfg.channelId);
      setDiscordEnabledInput(cfg.enabled);
      setDiscordLeadsRows(
        (cfg.reminderTimesOfDay ?? []).length > 0
          ? cfg.reminderTimesOfDay.map((s: string) => to12h(s))
          : [to12h('16:00'), to12h('19:30')]
      );
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (currentUser?.role !== 'ADMIN') return;
    void loadDiscord();
  }, [currentUser?.role]);

  async function saveDiscord() {
    if (!discordCfg) return;
    setDiscordSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (!discordCfg.enabledFromEnv) body.enabled = discordEnabledInput;
      if (!discordCfg.channelIdFromEnv) body.channelId = discordChannelInput.trim();
      if (!discordCfg.tokenFromEnv && discordTokenInput.trim()) {
        body.token = discordTokenInput.trim();
      }
      const times = discordLeadsRows
        .map((r) => to24h({ hour: r.hour, minute: r.minute, meridiem: r.meridiem }))
        .filter((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
      if (times.length > 0) body.reminderTimesOfDay = times;
      await apiFetch('/discord/config', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setDiscordTokenInput('');
      await loadDiscord();
      setDiscordSaved(true);
      window.setTimeout(() => setDiscordSaved(false), 2000);
    } finally {
      setDiscordSaving(false);
    }
  }

  async function testDiscord() {
    setDiscordTestResult(null);
    try {
      await apiFetch('/discord/test', { method: 'POST' });
      setDiscordTestResult('✓ Test message sent.');
    } catch (e) {
      if (e instanceof ApiErrorException) {
        setDiscordTestResult(`✗ ${e.payload.message}`);
      } else {
        setDiscordTestResult(`✗ ${(e as Error).message}`);
      }
    }
  }

  async function clearDiscordToken() {
    if (!window.confirm('Clear the saved Discord bot token?')) return;
    await apiFetch('/discord/config', {
      method: 'PATCH',
      body: JSON.stringify({ token: null }),
    });
    setDiscordTokenInput('');
    await loadDiscord();
  }

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
  async function mergeDupGroup(group: DuplicateGroup, keepId: string) {
    const others = group.sessions.filter((s) => s.id !== keepId);
    if (others.length === 0) return;
    const ok = window.confirm(
      `Merge ${others.length} session(s) into the keeper for ${group.netName} on ${group.date}? ` +
      'Check-ins will be re-parented and duplicates by callsign will be dropped.',
    );
    if (!ok) return;
    await apiFetch('/admin/duplicate-sessions/merge', {
      method: 'POST',
      body: JSON.stringify({
        keepSessionId: keepId,
        mergeSessionIds: others.map((s) => s.id),
      }),
    });
    await refreshDupes();
  }

  async function autoMergeAll(strategy: 'most-checkins' | 'earliest') {
    const label = strategy === 'most-checkins'
      ? 'most check-ins win'
      : 'keep earliest';
    if (!window.confirm(`Auto-merge every duplicate group (${label})?`)) return;
    await apiFetch('/admin/duplicate-sessions/auto-merge-all', {
      method: 'POST',
      body: JSON.stringify({ strategy }),
    });
    await refreshDupes();
  }

  async function purgeCheckIn(c: TrashCheckIn) {
    if (!window.confirm(
      `Permanently delete the check-in ${displayCallsign(c.callsign)} — ${c.nameAtCheckIn}? This cannot be undone.`,
    )) return;
    await apiFetch(`/admin/trash/checkins/${c.id}`, { method: 'DELETE' });
    await refreshTrash();
  }

  async function backfillNames() {
    // TODO: future — add scope picker (by net, by date range). v1 is scope: 'all'.
    if (!window.confirm(
      'Look up FCC names for all check-ins missing a real name? '
      + 'This may make many network calls and take a minute.',
    )) return;
    setBackfillBusy(true);
    setBackfillResult(null);
    try {
      const r = await apiFetch<{ scanned: number; updated: number; lookedUp: number }>(
        '/admin/backfill-names',
        { method: 'POST', body: JSON.stringify({ scope: 'all' }) },
      );
      setBackfillResult(
        `Scanned ${r.scanned} check-in(s); updated ${r.updated}, looked up ${r.lookedUp} from FCC.`,
      );
    } catch (e) {
      setBackfillResult((e as Error).message);
    } finally {
      setBackfillBusy(false);
    }
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
        <div style={{ height: 12 }} />
        <p style={{ fontSize: 13, opacity: 0.8 }}>
          Find existing check-ins whose name is empty or just the callsign and
          re-run the FCC lookup chain to populate real names.
        </p>
        <Button onClick={backfillNames} disabled={backfillBusy} variant="secondary">
          {backfillBusy ? 'Looking up…' : 'Backfill missing names from FCC'}
        </Button>
        {backfillResult && (
          <div style={{ fontSize: 13, marginTop: 6 }}>{backfillResult}</div>
        )}
      </Card>
      <div style={{ height: 16 }} />
      {discordCfg && (
        <Card>
          <h3>Discord integration</h3>
          <p style={{ fontSize: 13, opacity: 0.8 }}>
            Mirror the in-app chat to a Discord channel during active nets and
            post reminders before each scheduled net. Env vars
            (<code>DISCORD_BOT_TOKEN</code>, <code>DISCORD_CHANNEL_ID</code>,{' '}
            <code>DISCORD_ENABLED</code>) override these settings if set; fields
            driven by env are disabled and marked <em>(env)</em>.
          </p>
          <div className="hna-form">
            <div className="hna-field">
              <label>
                <input
                  type="checkbox"
                  checked={discordEnabledInput}
                  onChange={(e) => setDiscordEnabledInput(e.target.checked)}
                  disabled={discordCfg.enabledFromEnv}
                />
                {' '}Enabled{' '}
                {discordCfg.enabledFromEnv && <em>(env)</em>}
              </label>
            </div>
            <div className="hna-field">
              <label>
                Bot token{' '}
                {discordCfg.tokenFromEnv && <em>(env)</em>}
              </label>
              <Input
                type="password"
                placeholder={discordCfg.tokenSet ? 'set — leave blank to keep' : 'not set'}
                value={discordTokenInput}
                onChange={(e) => setDiscordTokenInput(e.target.value)}
                disabled={discordCfg.tokenFromEnv}
              />
              {discordCfg.tokenSet && !discordCfg.tokenFromEnv && (
                <button
                  type="button"
                  onClick={clearDiscordToken}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-danger)',
                    cursor: 'pointer',
                    fontSize: 12,
                    padding: 0,
                    marginTop: 4,
                  }}
                >
                  Clear token
                </button>
              )}
            </div>
            <div className="hna-field">
              <label>
                Channel ID{' '}
                {discordCfg.channelIdFromEnv && <em>(env)</em>}
              </label>
              <Input
                value={discordChannelInput}
                onChange={(e) => setDiscordChannelInput(e.target.value)}
                disabled={discordCfg.channelIdFromEnv}
                placeholder="123456789012345678"
              />
            </div>
            <div className="hna-field">
              <label>Reminder times</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {discordLeadsRows.map((row, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <select
                      className="hna-input"
                      value={row.hour}
                      onChange={(e) => {
                        const next = [...discordLeadsRows];
                        next[i] = { ...next[i]!, hour: Number(e.target.value) };
                        setDiscordLeadsRows(next);
                      }}
                      style={{ width: 70 }}
                    >
                      {Array.from({ length: 12 }, (_, k) => k + 1).map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 14 }}>:</span>
                    <select
                      className="hna-input"
                      value={row.minute - (row.minute % 5)}
                      onChange={(e) => {
                        const next = [...discordLeadsRows];
                        next[i] = { ...next[i]!, minute: Number(e.target.value) };
                        setDiscordLeadsRows(next);
                      }}
                      style={{ width: 70 }}
                    >
                      {Array.from({ length: 12 }, (_, k) => k * 5).map((m) => (
                        <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
                      ))}
                    </select>
                    <select
                      className="hna-input"
                      value={row.meridiem}
                      onChange={(e) => {
                        const next = [...discordLeadsRows];
                        next[i] = { ...next[i]!, meridiem: e.target.value as 'AM' | 'PM' };
                        setDiscordLeadsRows(next);
                      }}
                      style={{ width: 70 }}
                    >
                      <option value="AM">AM</option>
                      <option value="PM">PM</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => setDiscordLeadsRows(discordLeadsRows.filter((_, j) => j !== i))}
                      aria-label="Remove"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--color-danger)',
                        fontSize: 18,
                        padding: 4,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {discordLeadsRows.length < 5 && (
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => setDiscordLeadsRows([...discordLeadsRows, { hour: 4, minute: 0, meridiem: 'PM' }])}
                    style={{ alignSelf: 'flex-start', fontSize: 13, padding: '4px 12px' }}
                  >
                    + Add reminder
                  </Button>
                )}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                Pick the time(s) of day to ping Discord on the day of a net.
                Reminders set after the net's start time are skipped.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button onClick={saveDiscord} disabled={discordSaving}>Save</Button>
              <Button variant="secondary" onClick={testDiscord}>
                Send test message
              </Button>
              {discordSaved && (
                <span style={{ color: 'var(--color-success)' }}>Saved</span>
              )}
            </div>
            {discordTestResult && (
              <div style={{ fontSize: 13, marginTop: 8 }}>{discordTestResult}</div>
            )}
          </div>
        </Card>
      )}
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
      <div style={{ height: 16 }} />
      <Card>
        <h3>Duplicate sessions</h3>
        <p style={{ fontSize: 13, opacity: 0.8 }}>
          Multiple non-deleted sessions exist for the same net on the same calendar day.
          Merge to keep one canonical session per day.
        </p>
        {dupes && dupes.length > 0 ? (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <Button onClick={() => autoMergeAll('most-checkins')}>
                Auto-merge all (most check-ins win)
              </Button>
              <Button variant="secondary" onClick={() => autoMergeAll('earliest')}>
                Auto-merge all (keep earliest)
              </Button>
            </div>
            {dupes.map((g) => (
              <DuplicateGroupRow
                key={`${g.netId}|${g.date}`}
                group={g}
                onMerge={(keepId) => mergeDupGroup(g, keepId)}
              />
            ))}
          </>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.7, fontStyle: 'italic' }}>
            No duplicates found. Sessions are unique per net per calendar day.
          </div>
        )}
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

function pickDefaultKeeper(group: DuplicateGroup): string {
  let keeper = group.sessions[0]!;
  for (const s of group.sessions) {
    if (
      s.checkInCount > keeper.checkInCount ||
      (s.checkInCount === keeper.checkInCount && s.startedAt < keeper.startedAt)
    ) {
      keeper = s;
    }
  }
  return keeper.id;
}

function formatGroupDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map((p) => Number(p));
  if (!y || !m || !d) return ymd;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function DuplicateGroupRow({
  group,
  onMerge,
}: {
  group: DuplicateGroup;
  onMerge: (keepId: string) => void | Promise<void>;
}) {
  const [keepId, setKeepId] = useState<string>(() => pickDefaultKeeper(group));
  // If the group composition changes (e.g. fewer sessions), reset.
  useEffect(() => {
    if (!group.sessions.some((s) => s.id === keepId)) {
      setKeepId(pickDefaultKeeper(group));
    }
  }, [group, keepId]);

  return (
    <div
      style={{
        marginBottom: 16,
        padding: 12,
        border: '1px solid var(--color-border)',
        borderRadius: 6,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        {group.netName} — {formatGroupDate(group.date)}
      </div>
      <div className="hna-table-scroll">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Keep</th>
              <th align="left">Started</th>
              <th align="left">Topic</th>
              <th align="left">Control</th>
              <th align="left">Check-ins</th>
              <th align="left">Status</th>
            </tr>
          </thead>
          <tbody>
            {group.sessions.map((s) => (
              <tr key={s.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td>
                  <input
                    type="radio"
                    name={`keep-${group.netId}-${group.date}`}
                    checked={keepId === s.id}
                    onChange={() => setKeepId(s.id)}
                  />
                </td>
                <td>{formatTime(s.startedAt)}</td>
                <td>{s.topicTitle ?? '—'}</td>
                <td>
                  {s.controlOpCallsign
                    ? `${s.controlOpCallsign}${s.controlOpName ? ` (${s.controlOpName})` : ''}`
                    : '—'}
                </td>
                <td>{s.checkInCount}</td>
                <td>{s.endedAt ? 'ended' : 'running'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Button onClick={() => onMerge(keepId)}>Merge</Button>
      </div>
    </div>
  );
}
