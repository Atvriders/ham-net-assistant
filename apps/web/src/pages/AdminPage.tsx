import React, { useEffect, useId, useState } from 'react';
import type { PublicUser } from '@hna/shared';
import { ROLE_LABEL, Role } from '@hna/shared';
import { apiFetch, isAbortError, ApiErrorException, errorMessage } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { ConfirmModal } from '../components/ui/ConfirmModal.js';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { displayCallsign } from '../lib/format.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { UlsMirrorCard } from '../components/UlsMirrorCard.js';
import { usePresence } from '../lib/usePresence.js';
import { OnlineDot } from '../components/OnlineDot.js';
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
}

type Confirm =
  | { kind: 'deleteUser'; user: PublicUser }
  | { kind: 'clearDiscord' }
  | { kind: 'purgeSession'; session: TrashSession }
  | { kind: 'purgeCheckIn'; checkIn: TrashCheckIn }
  | { kind: 'mergeGroup'; group: DuplicateGroup; keepId: string }
  | { kind: 'autoMerge'; strategy: 'most-checkins' | 'earliest' }
  | { kind: 'backfillNames' };

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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

export function AdminPage() {
  const { user: currentUser } = useAuth();
  const { all: allThemes } = useTheme();
  const { data: users, refresh } = useAutoFetch<PublicUser[]>('/users', {
    intervalMs: 5000,
  });
  const { isOnlineById } = usePresence();
  const { data: trash, refresh: refreshTrash } = useAutoFetch<TrashPayload>('/admin/trash', {
    intervalMs: 15000,
  });
  const { data: dupes, refresh: refreshDupes } = useAutoFetch<DuplicateGroup[]>(
    '/admin/duplicate-sessions',
    { intervalMs: 30000 },
  );
  const [defaultSlug, setDefaultSlug] = useState<string>('default');
  const [defaultSaved, setDefaultSaved] = useState<string | null>(null);
  const [defaultThemeSaving, setDefaultThemeSaving] = useState(false);
  const [defaultThemeError, setDefaultThemeError] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [discordSaveError, setDiscordSaveError] = useState<string | null>(null);
  const [logImportOpen, setLogImportOpen] = useState(false);
  const [discordCfg, setDiscordCfg] = useState<DiscordConfig | null>(null);
  const [discordTokenInput, setDiscordTokenInput] = useState('');
  const [discordChannelInput, setDiscordChannelInput] = useState('');
  const [discordEnabledInput, setDiscordEnabledInput] = useState(false);
  const [discordSaving, setDiscordSaving] = useState(false);
  const [discordSaved, setDiscordSaved] = useState(false);
  const [discordTestResult, setDiscordTestResult] = useState<string | null>(null);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // In-app replacement for the two window.alert() sinks this page used to end
  // in (a restore notice and the catch-all for every confirmed action). A
  // native alert is unstyled, blocks the event loop, is suppressible by the
  // browser after a couple of firings, and simply doesn't exist in a kiosk or
  // an embedded webview — so an admin could run a destructive action, have it
  // fail, and see nothing at all.
  const [banner, setBanner] = useState<
    { kind: 'info' | 'error'; text: string } | null
  >(null);

  // Form ids for label associations
  const defaultThemeId = useId();
  const discordEnabledId = useId();
  const discordTokenId = useId();
  const discordChannelId = useId();

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
    setDiscordSaveError(null);
    try {
      const body: Record<string, unknown> = {};
      if (!discordCfg.enabledFromEnv) body.enabled = discordEnabledInput;
      if (!discordCfg.channelIdFromEnv) body.channelId = discordChannelInput.trim();
      if (!discordCfg.tokenFromEnv && discordTokenInput.trim()) {
        body.token = discordTokenInput.trim();
      }
      await apiFetch('/discord/config', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setDiscordTokenInput('');
      await loadDiscord();
      setDiscordSaved(true);
      window.setTimeout(() => setDiscordSaved(false), 2000);
    } catch (e) {
      // Mirror the sibling testDiscord: surface the failure instead of letting
      // the `finally` swallow it into a silent no-op.
      setDiscordSaveError(errorMessage(e));
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

  async function performClearDiscordToken() {
    await apiFetch('/discord/config', {
      method: 'PATCH',
      body: JSON.stringify({ token: null }),
    });
    setDiscordTokenInput('');
    await loadDiscord();
  }

  async function setRole(id: string, role: Role) {
    setRoleError(null);
    try {
      await apiFetch(`/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
      await refresh();
    } catch (e) {
      // On failure the 5s /users poll snaps the dropdown back — say why.
      setRoleError(errorMessage(e));
    }
  }

  async function performDeleteUser(u: PublicUser) {
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
      setBanner({
        kind: 'info',
        text: 'Check-in restored, but its session is still in the trash. Restore the session to see it.',
      });
    }
    await refreshTrash();
  }
  async function performPurgeSession(s: TrashSession) {
    await apiFetch(`/admin/trash/sessions/${s.id}`, { method: 'DELETE' });
    await refreshTrash();
  }
  async function performMergeGroup(group: DuplicateGroup, keepId: string) {
    const others = group.sessions.filter((s) => s.id !== keepId);
    if (others.length === 0) return;
    await apiFetch('/admin/duplicate-sessions/merge', {
      method: 'POST',
      body: JSON.stringify({
        keepSessionId: keepId,
        mergeSessionIds: others.map((s) => s.id),
      }),
    });
    await refreshDupes();
  }

  async function performAutoMerge(strategy: 'most-checkins' | 'earliest') {
    await apiFetch('/admin/duplicate-sessions/auto-merge-all', {
      method: 'POST',
      body: JSON.stringify({ strategy }),
    });
    await refreshDupes();
  }

  async function performPurgeCheckIn(c: TrashCheckIn) {
    await apiFetch(`/admin/trash/checkins/${c.id}`, { method: 'DELETE' });
    await refreshTrash();
  }

  async function performBackfillNames() {
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
    if (defaultThemeSaving) return;
    setDefaultThemeSaving(true);
    setDefaultThemeError(null);
    try {
      const res = await apiFetch<{ slug: string }>('/themes/default', {
        method: 'PATCH',
        body: JSON.stringify({ slug: defaultSlug }),
      });
      setDefaultSlug(res.slug);
      setDefaultSaved(res.slug);
      window.setTimeout(() => setDefaultSaved(null), 2000);
    } catch (e) {
      setDefaultThemeError(errorMessage(e));
    } finally {
      setDefaultThemeSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <header className="hna-page-header">
        <p className="hna-page-marker">// 07 — ADMIN</p>
        <h1 className="hna-page-title">Admin</h1>
        <p className="hna-page-sub">
          Club configuration and member management. Destructive actions
          show a confirmation modal before they run.
        </p>
      </header>

      {banner && (
        <Card>
          <div
            // Errors interrupt (assertive); the restore notice is informational
            // and announces politely.
            role={banner.kind === 'error' ? 'alert' : 'status'}
            data-testid="admin-banner"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              color:
                banner.kind === 'error'
                  ? 'var(--color-danger)'
                  : 'var(--color-fg)',
            }}
          >
            <span
              className="hna-mono"
              style={{ fontSize: 12, letterSpacing: '0.06em' }}
            >
              {banner.text}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBanner(null)}
              aria-label="Dismiss"
            >
              ✕
            </Button>
          </div>
        </Card>
      )}

      {/* MEMBERS */}
      <p className="hna-cap hna-cap--accent">[ MEMBERS ]</p>
      {roleError && (
        <p className="hna-input-error" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
          {roleError}
        </p>
      )}
      <Card>
        <div className="hna-section-caption">
          <h2 className="hna-section-caption__title">Members</h2>
          <span className="hna-section-caption__count">
            {users === null ? '—' : `${users.length} TOTAL`}
          </span>
        </div>
        {users === null && (
          <p
            className="hna-mono"
            style={{ margin: 0, color: 'var(--color-fg-muted)', fontSize: 12 }}
          >
            LOADING…
          </p>
        )}
        {users !== null && users.length === 0 && (
          <p
            className="hna-mono"
            style={{ margin: 0, color: 'var(--color-fg-muted)', fontSize: 12 }}
          >
            No members yet.
          </p>
        )}
        {users !== null && users.length > 0 && (
          <div className="hna-table-scroll" style={{ overflowX: 'auto' }}>
            <table className="hna-log-table" style={{ minWidth: 720 }}>
              <caption className="sr-only">Club members</caption>
              <thead>
                <tr>
                  <th scope="col">Callsign</th>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Theme</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <th scope="row" className="hna-log-table__cs" style={{ textAlign: 'left' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <OnlineDot online={isOnlineById(u.id)} />
                        {displayCallsign(u.callsign)}
                      </span>
                    </th>
                    <td>{u.name}</td>
                    <td
                      className="hna-mono"
                      style={{ fontSize: 12, color: 'var(--color-fg-muted)' }}
                    >
                      {u.email}
                    </td>
                    <td>
                      <span className="hna-chip">{ROLE_LABEL[u.role]}</span>
                    </td>
                    <td>
                      <select
                        className="hna-input"
                        value={u.collegeSlug ?? ''}
                        onChange={(e) => setUserTheme(u.id, e.target.value)}
                        aria-label={`Theme for ${displayCallsign(u.callsign)}`}
                        style={{ minHeight: 32 }}
                      >
                        <option value="">(default)</option>
                        {allThemes.map((t) => (
                          <option key={t.slug} value={t.slug}>{t.shortName ?? t.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          gap: 6,
                          flexWrap: 'wrap',
                          alignItems: 'center',
                        }}
                      >
                        {/* Role assignment. Options come from the shared Role
                            enum (Member / Net Control / Officer / Admin) with
                            the shared label map, so granting NET_CONTROL is a
                            single dropdown pick. */}
                        <select
                          className="hna-input"
                          value={u.role}
                          onChange={(e) => setRole(u.id, e.target.value as Role)}
                          aria-label={`Role for ${displayCallsign(u.callsign)}`}
                          style={{ minHeight: 32 }}
                        >
                          {Role.options.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                        {currentUser && u.id !== currentUser.id && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setConfirm({ kind: 'deleteUser', user: u })}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* DISCORD */}
      {discordCfg && (
        <>
          <SectionDivider>DISCORD</SectionDivider>
          <Card>
            <p
              style={{
                fontSize: 13,
                color: 'var(--color-fg-muted)',
                marginTop: 0,
              }}
            >
              Mirror the in-app chat to a Discord channel during active nets and
              post reminders before each scheduled net. Env vars
              (<code>DISCORD_BOT_TOKEN</code>, <code>DISCORD_CHANNEL_ID</code>,{' '}
              <code>DISCORD_ENABLED</code>) override these settings if set;
              fields driven by env are disabled and marked <em>(env)</em>.
            </p>
            <div className="hna-form">
              <div className="hna-field">
                <label
                  htmlFor={discordEnabledId}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                    textTransform: 'none',
                    letterSpacing: 0,
                    fontFamily: 'var(--font-sans)',
                    fontSize: 14,
                    color: 'var(--color-fg)',
                    fontWeight: 500,
                  }}
                >
                  <input
                    id={discordEnabledId}
                    type="checkbox"
                    checked={discordEnabledInput}
                    onChange={(e) => setDiscordEnabledInput(e.target.checked)}
                    disabled={discordCfg.enabledFromEnv}
                  />
                  Enabled {discordCfg.enabledFromEnv && <em>(env)</em>}
                </label>
              </div>
              <div className="hna-field">
                <label htmlFor={discordTokenId}>
                  Bot token {discordCfg.tokenFromEnv && <em>(env)</em>}
                </label>
                <Input
                  id={discordTokenId}
                  type="password"
                  placeholder={discordCfg.tokenSet ? 'set — leave blank to keep' : 'not set'}
                  value={discordTokenInput}
                  onChange={(e) => setDiscordTokenInput(e.target.value)}
                  disabled={discordCfg.tokenFromEnv}
                />
                {discordCfg.tokenSet && !discordCfg.tokenFromEnv && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirm({ kind: 'clearDiscord' })}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    Clear token
                  </Button>
                )}
              </div>
              <div className="hna-field">
                <label htmlFor={discordChannelId}>
                  Channel ID {discordCfg.channelIdFromEnv && <em>(env)</em>}
                </label>
                <Input
                  id={discordChannelId}
                  value={discordChannelInput}
                  onChange={(e) => setDiscordChannelInput(e.target.value)}
                  disabled={discordCfg.channelIdFromEnv}
                  placeholder="123456789012345678"
                />
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <Button onClick={saveDiscord} disabled={discordSaving}>
                  Save
                </Button>
                <Button variant="secondary" onClick={testDiscord}>
                  Test
                </Button>
                {discordSaved && (
                  <span
                    className="hna-mono"
                    style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--color-success)' }}
                  >
                    SAVED
                  </span>
                )}
                {discordSaveError && (
                  <span className="hna-input-error" role="alert">
                    {discordSaveError}
                  </span>
                )}
              </div>
              {discordTestResult && (
                <p
                  className="hna-mono"
                  style={{ margin: 0, fontSize: 12, color: 'var(--color-fg-muted)' }}
                >
                  {discordTestResult}
                </p>
              )}
            </div>
          </Card>
        </>
      )}

      {/* THEME */}
      <SectionDivider>THEME</SectionDivider>
      <Card>
        <p
          style={{
            fontSize: 13,
            color: 'var(--color-fg-muted)',
            marginTop: 0,
          }}
        >
          New accounts will start on this theme. Existing users keep their
          current choice.
        </p>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'end',
            flexWrap: 'wrap',
          }}
        >
          <div className="hna-field" style={{ minWidth: 200 }}>
            <label htmlFor={defaultThemeId}>Default theme for new users</label>
            <select
              id={defaultThemeId}
              className="hna-input"
              value={defaultSlug}
              onChange={(e) => setDefaultSlug(e.target.value)}
            >
              {allThemes.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.shortName ?? t.name}
                </option>
              ))}
            </select>
          </div>
          {(() => {
            const swatch = allThemes.find((t) => t.slug === defaultSlug);
            if (!swatch) return null;
            return (
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: 28,
                  height: 28,
                  background: swatch.colors.primary,
                  border: '2px solid var(--color-border-strong)',
                  borderRadius: 4,
                }}
                title={swatch.shortName ?? swatch.name}
              />
            );
          })()}
          <Button onClick={saveDefaultTheme} disabled={defaultThemeSaving}>
            {defaultThemeSaving ? 'Saving…' : 'Save'}
          </Button>
          {defaultSaved && (
            <span
              className="hna-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.14em',
                color: 'var(--color-success)',
              }}
            >
              SAVED · {defaultSaved}
            </span>
          )}
          {defaultThemeError && (
            <span className="hna-input-error" role="alert">
              {defaultThemeError}
            </span>
          )}
        </div>
      </Card>

      {/* DUPLICATES */}
      <SectionDivider>DUPLICATES</SectionDivider>
      <Card>
        <p
          style={{
            fontSize: 13,
            color: 'var(--color-fg-muted)',
            marginTop: 0,
          }}
        >
          Multiple non-deleted sessions exist for the same net on the same
          calendar day. Merge to keep one canonical session per day.
        </p>
        {dupes && dupes.length > 0 ? (
          <>
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                flexWrap: 'wrap',
                marginBottom: 'var(--space-4)',
              }}
            >
              <Button onClick={() => setConfirm({ kind: 'autoMerge', strategy: 'most-checkins' })}>
                Auto-merge all (most check-ins win)
              </Button>
              <Button
                variant="secondary"
                onClick={() => setConfirm({ kind: 'autoMerge', strategy: 'earliest' })}
              >
                Auto-merge all (keep earliest)
              </Button>
            </div>
            {dupes.map((g) => (
              <DuplicateGroupRow
                key={`${g.netId}|${g.date}`}
                group={g}
                onMerge={(keepId) => setConfirm({ kind: 'mergeGroup', group: g, keepId })}
              />
            ))}
          </>
        ) : (
          <p
            className="hna-mono"
            style={{ margin: 0, color: 'var(--color-fg-muted)', fontSize: 12 }}
          >
            No duplicates found. Sessions are unique per net per calendar day.
          </p>
        )}
      </Card>

      {/* TRASH */}
      {trash && (trash.sessions.length > 0 || trash.checkIns.length > 0) && (
        <>
          <SectionDivider>TRASH</SectionDivider>
          <Card>
            <p
              style={{
                fontSize: 13,
                color: 'var(--color-fg-muted)',
                marginTop: 0,
              }}
            >
              Items deleted in the last 30 days. Restore to undo, or remove
              permanently.
            </p>
            <div className="hna-table-scroll" style={{ overflowX: 'auto' }}>
              <table className="hna-log-table" style={{ minWidth: 720 }}>
                <caption className="sr-only">
                  Recently deleted sessions and check-ins
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col">Description</th>
                    <th scope="col">Deleted at</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trash.sessions.map((s) => (
                    <tr key={`s-${s.id}`}>
                      <td><span className="hna-chip">Session</span></td>
                      <td>
                        <span className="hna-display" style={{ fontSize: 13 }}>
                          {s.netName}
                        </span>
                        {' — started '}
                        <span className="hna-mono" style={{ fontSize: 12 }}>
                          {formatWhen(s.startedAt)}
                        </span>
                        {s.topic ? ` (${s.topic})` : ''}
                        {s.checkInCount > 0 ? ` · ${s.checkInCount} check-in(s)` : ''}
                      </td>
                      <td
                        className="hna-mono"
                        style={{ fontSize: 12, color: 'var(--color-fg-muted)' }}
                      >
                        {formatWhen(s.deletedAt)}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => restoreSession(s.id)}
                          >
                            Restore
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setConfirm({ kind: 'purgeSession', session: s })}
                          >
                            Hard delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {trash.checkIns.map((c) => (
                    <tr key={`c-${c.id}`}>
                      <td><span className="hna-chip">Check-in</span></td>
                      <td>
                        <span
                          className="hna-mono"
                          style={{
                            color: 'var(--color-primary)',
                            fontWeight: 700,
                          }}
                        >
                          {displayCallsign(c.callsign)}
                        </span>
                        {' — '}{c.nameAtCheckIn} in {c.netName}
                      </td>
                      <td
                        className="hna-mono"
                        style={{ fontSize: 12, color: 'var(--color-fg-muted)' }}
                      >
                        {formatWhen(c.deletedAt)}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => restoreCheckIn(c.id)}
                          >
                            Restore
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setConfirm({ kind: 'purgeCheckIn', checkIn: c })}
                          >
                            Hard delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* TOOLS */}
      <SectionDivider>TOOLS</SectionDivider>
      <UlsMirrorCard />
      <Card>
        <p
          style={{
            fontSize: 13,
            color: 'var(--color-fg-muted)',
            marginTop: 0,
          }}
        >
          Bulk-import historical net logs from a Google Doc or pasted text.
          Sessions are attached to a Net you choose, with check-ins linked to
          existing members by callsign.
        </p>
        <Button onClick={() => setLogImportOpen(true)}>
          Import historical logs
        </Button>
        <div
          style={{
            marginTop: 'var(--space-4)',
            paddingTop: 'var(--space-4)',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <p
            style={{
              fontSize: 13,
              color: 'var(--color-fg-muted)',
              marginTop: 0,
            }}
          >
            Find existing check-ins whose name is empty or just the callsign
            and re-run the FCC lookup chain to populate real names.
          </p>
          <Button
            onClick={() => setConfirm({ kind: 'backfillNames' })}
            disabled={backfillBusy}
            variant="secondary"
          >
            {backfillBusy ? 'Looking up…' : 'Look up missing real names'}
          </Button>
          {backfillResult && (
            <p
              className="hna-mono"
              style={{
                marginTop: 8,
                fontSize: 12,
                color: 'var(--color-fg-muted)',
              }}
            >
              {backfillResult}
            </p>
          )}
        </div>
      </Card>

      <LogImportModal
        open={logImportOpen}
        onClose={() => setLogImportOpen(false)}
        onImported={() => { /* nothing else needed */ }}
      />

      {/* Confirmation modal — dispatched by the `confirm` state machine */}
      <ConfirmModal
        open={confirm !== null}
        title={confirm ? confirmTitle(confirm) : 'Confirm'}
        message={confirm ? confirmMessage(confirm) : ''}
        confirmLabel={confirm ? confirmActionLabel(confirm) : 'Confirm'}
        destructive={confirm ? confirmIsDestructive(confirm) : true}
        onConfirm={() => {
          if (!confirm) return;
          const c = confirm;
          setConfirm(null);
          setBanner(null);
          // Run the underlying action; a failure lands in the page banner
          // above so it survives long enough to be read (and copied).
          (async () => {
            try {
              switch (c.kind) {
                case 'deleteUser':
                  await performDeleteUser(c.user);
                  break;
                case 'clearDiscord':
                  await performClearDiscordToken();
                  break;
                case 'purgeSession':
                  await performPurgeSession(c.session);
                  break;
                case 'purgeCheckIn':
                  await performPurgeCheckIn(c.checkIn);
                  break;
                case 'mergeGroup':
                  await performMergeGroup(c.group, c.keepId);
                  break;
                case 'autoMerge':
                  await performAutoMerge(c.strategy);
                  break;
                case 'backfillNames':
                  await performBackfillNames();
                  break;
              }
            } catch (e) {
              setBanner({ kind: 'error', text: errorMessage(e) });
            }
          })();
        }}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

function confirmTitle(c: Confirm): string {
  switch (c.kind) {
    case 'deleteUser':
      return 'Delete member';
    case 'clearDiscord':
      return 'Clear Discord bot token';
    case 'purgeSession':
      return 'Hard-delete session';
    case 'purgeCheckIn':
      return 'Hard-delete check-in';
    case 'mergeGroup':
      return 'Merge duplicate sessions';
    case 'autoMerge':
      return 'Auto-merge duplicates';
    case 'backfillNames':
      return 'Look up missing names';
  }
}

function confirmMessage(c: Confirm): string {
  switch (c.kind) {
    case 'deleteUser':
      return `Delete user ${displayCallsign(c.user.callsign)} — ${c.user.name}? This cannot be undone.`;
    case 'clearDiscord':
      return 'Clear the saved Discord bot token?';
    case 'purgeSession':
      return `Permanently delete the session for ${c.session.netName} started ${formatWhen(c.session.startedAt)}? This cannot be undone.`;
    case 'purgeCheckIn':
      return `Permanently delete the check-in ${displayCallsign(c.checkIn.callsign)} — ${c.checkIn.nameAtCheckIn}? This cannot be undone.`;
    case 'mergeGroup': {
      const others = c.group.sessions.filter((s) => s.id !== c.keepId);
      return (
        `Merge ${others.length} session(s) into the keeper for ${c.group.netName} on ${c.group.date}? ` +
        'Check-ins will be re-parented and duplicates by callsign will be dropped.'
      );
    }
    case 'autoMerge': {
      const label = c.strategy === 'most-checkins' ? 'most check-ins win' : 'keep earliest';
      return `Auto-merge every duplicate group (${label})?`;
    }
    case 'backfillNames':
      return (
        'Look up FCC names for all check-ins missing a real name? ' +
        'This may make many network calls and take a minute.'
      );
  }
}

function confirmActionLabel(c: Confirm): string {
  switch (c.kind) {
    case 'deleteUser':
      return 'Delete member';
    case 'clearDiscord':
      return 'Clear token';
    case 'purgeSession':
    case 'purgeCheckIn':
      return 'Delete forever';
    case 'mergeGroup':
    case 'autoMerge':
      return 'Merge';
    case 'backfillNames':
      return 'Run lookup';
  }
}

function confirmIsDestructive(c: Confirm): boolean {
  // Only the merge / lookup actions are non-destructive
  return c.kind !== 'mergeGroup' && c.kind !== 'autoMerge' && c.kind !== 'backfillNames';
}

function DuplicateGroupRow({
  group,
  onMerge,
}: {
  group: DuplicateGroup;
  onMerge: (keepId: string) => void;
}) {
  const [keepId, setKeepId] = useState<string>(() => pickDefaultKeeper(group));
  useEffect(() => {
    if (!group.sessions.some((s) => s.id === keepId)) {
      setKeepId(pickDefaultKeeper(group));
    }
  }, [group, keepId]);

  return (
    <div
      style={{
        marginBottom: 'var(--space-4)',
        padding: 'var(--space-3)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-bg)',
      }}
    >
      <p
        className="hna-mono"
        style={{
          fontSize: 11,
          letterSpacing: '0.14em',
          color: 'var(--color-primary)',
          margin: 0,
          marginBottom: 'var(--space-2)',
        }}
      >
        <span className="hna-display" style={{ fontSize: 14, color: 'var(--color-fg)' }}>
          {group.netName}
        </span>
        {' · '}
        {formatGroupDate(group.date)}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="hna-log-table" style={{ minWidth: 600 }}>
          <caption className="sr-only">
            Duplicate sessions for {group.netName} on {formatGroupDate(group.date)} —
            pick which one to keep
          </caption>
          <thead>
            <tr>
              <th scope="col">Keep</th>
              <th scope="col">Started</th>
              <th scope="col">Topic</th>
              <th scope="col">Control</th>
              <th scope="col">Check-ins</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {group.sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <label className="hna-radio">
                    <input
                      type="radio"
                      name={`keep-${group.netId}-${group.date}`}
                      checked={keepId === s.id}
                      onChange={() => setKeepId(s.id)}
                      aria-label={`Keep session started ${formatTime(s.startedAt)}`}
                    />
                    <span className="hna-radio__mark" aria-hidden="true" />
                  </label>
                </td>
                <th scope="row" className="hna-mono" style={{ textAlign: 'left' }}>
                  {formatTime(s.startedAt)}
                </th>
                <td>{s.topicTitle ?? '—'}</td>
                <td className="hna-mono" style={{ fontSize: 12 }}>
                  {s.controlOpCallsign
                    ? `${s.controlOpCallsign}${s.controlOpName ? ` (${s.controlOpName})` : ''}`
                    : '—'}
                </td>
                <td
                  className="hna-mono"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {s.checkInCount}
                </td>
                <td>
                  <span className="hna-chip">
                    {s.endedAt ? 'ENDED' : 'RUNNING'}
                  </span>
                </td>
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
