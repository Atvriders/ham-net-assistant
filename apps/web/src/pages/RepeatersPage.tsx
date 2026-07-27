import React, { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Repeater, RepeaterInput } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { useAsyncAction } from '../lib/useAsyncAction.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Modal } from '../components/ui/Modal.js';
import { ConfirmModal } from '../components/ui/ConfirmModal.js';
import { useAuth } from '../auth/AuthProvider.js';
import { decodeGrid } from '../lib/grid.js';
import { CsvImportModal } from '../components/CsvImportModal.js';
import { formatOffset, formatTone } from '../lib/format.js';

interface CallsignLookupResponse {
  gridSquare: string | null;
}

const EMPTY_FORM: RepeaterInput = {
  name: '',
  frequency: 146.52,
  offsetKhz: 0,
  toneHz: null,
  mode: 'FM',
  coverage: null,
  latitude: null,
  longitude: null,
};

function sourceLabel(source: string): string {
  switch (source) {
    case 'ard':
      return 'Amateur Repeater Directory (CC0)';
    case 'hearham':
      return 'HearHam community database (fallback)';
    case 'none':
      return 'none';
    default:
      return source;
  }
}

function RepeaterDisplay({ r }: { r: RepeaterInput }) {
  return (
    <div className="hna-rep-card">
      <div>
        <h3 className="hna-rep-card__name">{r.name}</h3>
      </div>
      <div className="hna-rep-card__freq">{r.frequency.toFixed(3)} MHz</div>
      <div className="hna-rep-card__meta">
        OFFSET {formatOffset(r.offsetKhz)} · TONE {formatTone(r.toneHz)} ·{' '}
        {r.mode}
      </div>
      {r.coverage && (
        <div className="hna-rep-card__body">{r.coverage}</div>
      )}
      {(r.latitude != null && r.longitude != null) && (
        <div className="hna-mono" style={{ fontSize: 11, color: 'var(--color-fg-muted)', letterSpacing: '0.06em' }}>
          {r.latitude.toFixed(4)}, {r.longitude.toFixed(4)}
        </div>
      )}
    </div>
  );
}

export function RepeatersPage() {
  const { user } = useAuth();
  const isOfficer = user?.role === 'OFFICER' || user?.role === 'ADMIN';

  const nameId = useId();
  const freqId = useId();
  const offsetId = useId();
  const toneId = useId();
  const modeId = useId();
  const coverageId = useId();
  const gridId = useId();
  const latId = useId();
  const lonId = useId();
  const distId = useId();

  const {
    data: listData,
    error: listError,
    refresh: reload,
  } = useAutoFetch<Repeater[]>('/repeaters', { intervalMs: 15000 });
  const list = listData ?? [];
  const err = listError;

  const [editing, setEditing] = useState<Repeater | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<RepeaterInput>(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const [suggesting, setSuggesting] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<RepeaterInput[]>([]);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [topAlert, setTopAlert] = useState<string | null>(null);
  const [addingAll, setAddingAll] = useState(false);

  const [coordsOpen, setCoordsOpen] = useState(false);
  const [coordGrid, setCoordGrid] = useState('');
  const [coordLat, setCoordLat] = useState('');
  const [coordLon, setCoordLon] = useState('');
  const [coordDist, setCoordDist] = useState('30');
  const [coordErr, setCoordErr] = useState<string | null>(null);
  const [gridBusy, setGridBusy] = useState(false);
  const [suggestionSource, setSuggestionSource] = useState<string | null>(null);
  const [attemptedSources, setAttemptedSources] = useState<string[]>([]);

  const [csvOpen, setCsvOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Repeater | null>(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormErr(null);
    setShowForm(true);
  }
  function openEdit(r: Repeater) {
    setEditing(r);
    setForm({
      name: r.name,
      frequency: r.frequency,
      offsetKhz: r.offsetKhz,
      toneHz: r.toneHz ?? null,
      mode: r.mode,
      coverage: r.coverage ?? null,
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
    });
    setFormErr(null);
    setShowForm(true);
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    setFormBusy(true);
    setFormErr(null);
    try {
      if (editing) {
        await apiFetch(`/repeaters/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(form),
        });
      } else {
        await apiFetch('/repeaters', {
          method: 'POST',
          body: JSON.stringify(form),
        });
      }
      setShowForm(false);
      await reload();
    } catch (ex) {
      setFormErr(ex instanceof ApiErrorException ? ex.payload.message : 'Save failed');
    } finally {
      setFormBusy(false);
    }
  }

  // Repeater delete: the app's own ConfirmModal, not window.confirm — one
  // console, one set of dialogs. The server refuses (409) when any net or
  // logged session still points at the repeater and names the dependents in
  // its message, so the failure is surfaced *inside* the still-open modal
  // where the operator can read which nets are in the way. The page-level
  // `err`/`topAlert` only cover the list GET and discovery.
  const deleteAction = useAsyncAction(async (id: string) => {
    await apiFetch(`/repeaters/${id}`, { method: 'DELETE' });
    setConfirmDelete(null);
    await reload();
  });

  async function runDiscovery(query: string, openModal: boolean) {
    setSuggesting(true);
    setSuggestionError(null);
    setTopAlert(null);
    setSuggestions([]);
    setSuggestionSource(null);
    setAttemptedSources([]);
    if (openModal) setSuggestionsOpen(true);
    try {
      const result = await apiFetch<{
        suggestions: RepeaterInput[];
        reason?: string;
        source?: string;
        attempted?: string[];
      }>(`/repeaters/suggestions?${query}`);
      if (result.source) setSuggestionSource(result.source);
      if (Array.isArray(result.attempted)) setAttemptedSources(result.attempted);
      if (result.reason === 'upstream-error') {
        setSuggestionsOpen(false);
        const triedLabels = (result.attempted ?? []).map((s) => {
          if (s === 'ard') return 'ARD';
          if (s === 'hearham') return 'HearHam';
          return s;
        });
        const tried = triedLabels.join(' → ') || 'all known sources';
        setTopAlert(
          `Repeater databases are unreachable right now (tried: ${tried}). Try again later, or enter repeaters manually.`,
        );
        return;
      }
      if (!result.suggestions || result.suggestions.length === 0) {
        const reason = result.reason;
        const msg =
          reason === 'no-location'
            ? 'Could not locate your callsign. Callook.info had no coordinates for you.'
            : 'No nearby repeaters found.';
        if (!openModal) {
          setSuggestionsOpen(true);
        }
        setSuggestionError(msg);
      } else {
        setSuggestionsOpen(true);
        setSuggestions(result.suggestions);
      }
    } catch (ex) {
      setSuggestionsOpen(false);
      setTopAlert(
        ex instanceof ApiErrorException
          ? ex.payload.message
          : 'Discovery failed — try again later, or enter repeaters manually.',
      );
    } finally {
      setSuggesting(false);
    }
  }

  async function discoverLocal() {
    if (!user?.callsign) return;
    await runDiscovery(`callsign=${encodeURIComponent(user.callsign)}`, true);
  }

  function openCoords() {
    setCoordErr(null);
    setCoordGrid('');
    setCoordLat('');
    setCoordLon('');
    setCoordDist('30');
    setCoordsOpen(true);
  }

  function handleGridChange(value: string) {
    setCoordGrid(value);
    const decoded = decodeGrid(value);
    if (decoded) {
      setCoordLat(String(decoded.lat));
      setCoordLon(String(decoded.lon));
    }
  }

  async function autofillGridFromCallsign() {
    if (!user?.callsign) return;
    setGridBusy(true);
    setCoordErr(null);
    try {
      const result = await apiFetch<CallsignLookupResponse>(
        `/callsign-lookup/${encodeURIComponent(user.callsign)}`,
      );
      if (result.gridSquare) {
        handleGridChange(result.gridSquare);
      } else {
        setCoordErr('No grid square on file for your callsign.');
      }
    } catch (ex) {
      setCoordErr(
        ex instanceof ApiErrorException ? ex.payload.message : 'Lookup failed',
      );
    } finally {
      setGridBusy(false);
    }
  }

  async function submitCoords(e: React.FormEvent) {
    e.preventDefault();
    setCoordErr(null);
    const lat = Number(coordLat);
    const lon = Number(coordLon);
    const dist = Number(coordDist);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      setCoordErr('Latitude must be between -90 and 90');
      return;
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      setCoordErr('Longitude must be between -180 and 180');
      return;
    }
    if (!Number.isInteger(dist) || dist < 1 || dist > 100) {
      setCoordErr('Distance must be an integer between 1 and 100 miles');
      return;
    }
    setCoordsOpen(false);
    await runDiscovery(`lat=${lat}&lon=${lon}&dist=${dist}`, true);
  }

  async function addSuggestion(idx: number) {
    const r = suggestions[idx];
    if (!r) return;
    try {
      await apiFetch('/repeaters', { method: 'POST', body: JSON.stringify(r) });
      setSuggestions((prev) => prev.filter((_, i) => i !== idx));
      await reload();
    } catch (ex) {
      setSuggestionError(
        ex instanceof ApiErrorException ? ex.payload.message : 'Add failed',
      );
    }
  }

  async function addAllSuggestions() {
    if (suggestions.length === 0) return;
    setAddingAll(true);
    setSuggestionError(null);
    try {
      await Promise.all(
        suggestions.map((r) =>
          apiFetch('/repeaters', { method: 'POST', body: JSON.stringify(r) }).catch(
            () => null,
          ),
        ),
      );
      setSuggestions([]);
      await reload();
    } finally {
      setAddingAll(false);
    }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ marginBottom: 12 }}>
        <Link
          to="/nets"
          className="hna-mono"
          style={{
            color: 'var(--color-fg-muted)',
            fontSize: 11,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            textDecoration: 'none',
          }}
        >
          ← BACK TO NETS
        </Link>
      </div>

      <header className="hna-page-header">
        <p className="hna-page-marker">// 03 — REPEATERS</p>
        <h1 className="hna-page-title">Repeaters</h1>
        <p className="hna-page-sub">
          Linked frequencies and coverage. Officers can add, import, and
          discover nearby repeaters from the FCC and ARD databases.
        </p>
        {isOfficer && (
          <div className="hna-page-actions">
            <Button variant="primary" onClick={openCreate}>
              Add repeater
            </Button>
            <Button variant="secondary" onClick={discoverLocal} disabled={suggesting}>
              {suggesting ? 'Discovering…' : 'Discover local repeaters'}
            </Button>
            <Button variant="secondary" onClick={openCoords} disabled={suggesting}>
              Discover by coordinates
            </Button>
            <Button variant="secondary" onClick={() => setCsvOpen(true)}>
              Import from CSV
            </Button>
          </div>
        )}
      </header>

      {err && (
        <p role="alert" className="hna-input-error" style={{ marginTop: 8 }}>
          {err}
        </p>
      )}

      {topAlert && (
        <Card>
          <div
            role="alert"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              color: 'var(--color-danger)',
            }}
          >
            <span className="hna-mono" style={{ fontSize: 12, letterSpacing: '0.06em' }}>
              {topAlert}
            </span>
            <button
              type="button"
              onClick={() => setTopAlert(null)}
              className="hna-btn ghost size-sm"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </Card>
      )}

      {list.length === 0 ? (
        <section aria-label="No repeaters" style={{ marginTop: 16 }}>
          <p className="hna-cap">[ NO REPEATERS ]</p>
          <Card>
            {isOfficer ? (
              <div className="hna-empty">
                <p className="hna-empty__title">No repeaters yet</p>
                <p className="hna-empty__body">
                  Add your club&apos;s repeaters to start — try{' '}
                  <strong>Discover local repeaters</strong> if your callsign has
                  an FCC grid square, or <strong>Add repeater</strong> manually.
                </p>
                <div className="hna-empty__actions">
                  <Button variant="primary" onClick={discoverLocal} disabled={suggesting}>
                    {suggesting ? 'Discovering…' : 'Discover local repeaters'}
                  </Button>
                  <Button variant="secondary" onClick={openCreate}>
                    Add repeater
                  </Button>
                </div>
              </div>
            ) : (
              <div className="hna-empty">
                <p className="hna-empty__title">No repeaters listed yet</p>
                <p className="hna-empty__body">
                  No repeaters listed yet. Ask a club officer to add one.
                </p>
              </div>
            )}
          </Card>
        </section>
      ) : (
        <section aria-label="Repeaters" style={{ marginTop: 16 }}>
          <p className="hna-cap hna-cap--accent">[ ACTIVE REPEATERS ]</p>
          <div className="hna-repeater-grid">
            {list.map((r) => (
              <Card key={r.id}>
                <RepeaterDisplay r={r} />
                {isOfficer && (
                  <div className="hna-rep-card__actions">
                    <Button variant="secondary" onClick={() => openEdit(r)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        deleteAction.reset();
                        setConfirmDelete(r);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}

      <ConfirmModal
        open={confirmDelete !== null}
        title="Delete repeater"
        message={
          <>
            Delete <strong>{confirmDelete?.name}</strong>
            {confirmDelete ? ` (${confirmDelete.frequency.toFixed(3)} MHz)` : ''}?
            <span style={{ display: 'block', marginTop: 8 }}>
              A repeater that a net or a logged session still uses can&rsquo;t
              be deleted — the server will list what depends on it. Point those
              nets at another repeater first.
            </span>
            {deleteAction.error && (
              <span
                className="hna-input-error"
                role="alert"
                data-testid="repeater-delete-error"
                style={{ display: 'block', marginTop: 8 }}
              >
                {deleteAction.error}
              </span>
            )}
          </>
        }
        confirmLabel="Delete"
        onClose={() => {
          setConfirmDelete(null);
          deleteAction.reset();
        }}
        onConfirm={() => {
          if (confirmDelete) void deleteAction.run(confirmDelete.id);
        }}
      />

      <CsvImportModal
        open={csvOpen}
        onClose={() => setCsvOpen(false)}
        onImported={() => {
          reload().catch(() => {});
        }}
      />

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing ? 'Edit repeater' : 'Add repeater'}
      >
        <form onSubmit={submitForm}>
          <div className="hna-form">
            <div className="hna-field">
              <label htmlFor={nameId}>Name</label>
              <Input
                id={nameId}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="hna-field">
              <label htmlFor={freqId}>Frequency (MHz)</label>
              <Input
                id={freqId}
                type="number"
                step="0.001"
                value={form.frequency}
                onChange={(e) => setForm({ ...form, frequency: Number(e.target.value) })}
                required
              />
            </div>
            <div className="hna-field">
              <label htmlFor={offsetId}>Offset (kHz)</label>
              <Input
                id={offsetId}
                type="number"
                value={form.offsetKhz}
                onChange={(e) => setForm({ ...form, offsetKhz: Number(e.target.value) })}
                required
              />
            </div>
            <div className="hna-field">
              <label htmlFor={toneId}>Tone (Hz)</label>
              <Input
                id={toneId}
                type="number"
                step="0.1"
                value={form.toneHz ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    toneHz: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </div>
            <div className="hna-field">
              <label htmlFor={modeId}>Mode</label>
              <select
                id={modeId}
                className="hna-input"
                value={form.mode}
                onChange={(e) =>
                  setForm({ ...form, mode: e.target.value as RepeaterInput['mode'] })
                }
              >
                <option value="FM">FM</option>
                <option value="DMR">DMR</option>
                <option value="D-STAR">D-STAR</option>
                <option value="Fusion">Fusion</option>
              </select>
            </div>
            <div className="hna-field">
              <label htmlFor={coverageId}>Coverage</label>
              <Input
                id={coverageId}
                value={form.coverage ?? ''}
                onChange={(e) =>
                  setForm({ ...form, coverage: e.target.value || null })
                }
              />
            </div>
          </div>
          {formErr && (
            <p role="alert" className="hna-input-error" style={{ marginTop: 8 }}>
              {formErr}
            </p>
          )}
          <div className="hna-modal-actions">
            <Button type="submit" variant="primary" disabled={formBusy}>
              {formBusy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={coordsOpen}
        onClose={() => setCoordsOpen(false)}
        title="Discover by coordinates"
      >
        <form onSubmit={submitCoords}>
          <div className="hna-form">
            <div className="hna-field">
              <label htmlFor={gridId}>Grid square (Maidenhead)</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Input
                  id={gridId}
                  value={coordGrid}
                  onChange={(e) => handleGridChange(e.target.value)}
                  placeholder="EM19jd"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={autofillGridFromCallsign}
                  disabled={gridBusy || !user?.callsign}
                >
                  {gridBusy ? 'Looking up…' : 'Auto-fill from callsign'}
                </Button>
              </div>
            </div>
            <div className="hna-field">
              <label htmlFor={latId}>Latitude</label>
              <Input
                id={latId}
                type="number"
                step="0.0001"
                value={coordLat}
                onChange={(e) => setCoordLat(e.target.value)}
                placeholder="39.18"
                required
              />
            </div>
            <div className="hna-field">
              <label htmlFor={lonId}>Longitude</label>
              <Input
                id={lonId}
                type="number"
                step="0.0001"
                value={coordLon}
                onChange={(e) => setCoordLon(e.target.value)}
                placeholder="-96.57"
                required
              />
            </div>
            <div className="hna-field">
              <label htmlFor={distId}>Distance (miles, 1-100)</label>
              <Input
                id={distId}
                type="number"
                min={1}
                max={100}
                value={coordDist}
                onChange={(e) => setCoordDist(e.target.value)}
                required
              />
            </div>
          </div>
          {coordErr && (
            <p role="alert" className="hna-input-error" style={{ marginTop: 8 }}>
              {coordErr}
            </p>
          )}
          <div className="hna-modal-actions">
            <Button type="submit" variant="primary">
              Search
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCoordsOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={suggestionsOpen}
        onClose={() => setSuggestionsOpen(false)}
        size="wide"
        title={`Suggested repeaters near ${user?.callsign ?? ''}`}
      >
        {suggesting && (
          <p className="hna-mono" style={{ color: 'var(--color-fg-muted)' }}>
            Loading…
          </p>
        )}
        {suggestionError && (
          <p role="alert" className="hna-input-error" style={{ marginTop: 8 }}>
            {suggestionError}
          </p>
        )}
        {!suggesting && suggestions.length > 0 && (
          <>
            <div style={{ marginBottom: 12 }}>
              <Button variant="primary" onClick={addAllSuggestions} disabled={addingAll}>
                {addingAll ? 'Adding…' : `Add all (${suggestions.length})`}
              </Button>
            </div>
            {suggestionSource && (
              <p
                className="hna-mono"
                style={{
                  fontSize: 11,
                  color: 'var(--color-fg-muted)',
                  letterSpacing: '0.06em',
                  marginBottom: 8,
                }}
              >
                Source: {sourceLabel(suggestionSource)}
                {attemptedSources.length > 1 &&
                  ` (tried: ${attemptedSources.join(' → ')})`}
              </p>
            )}
            <div style={{ display: 'grid', gap: 12, maxHeight: 400, overflowY: 'auto' }}>
              {suggestions.map((s, i) => (
                <Card key={`${s.name}-${i}`}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <RepeaterDisplay r={s} />
                    <Button variant="primary" onClick={() => addSuggestion(i)}>
                      Add
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
        <div className="hna-modal-actions">
          <Button variant="secondary" onClick={() => setSuggestionsOpen(false)}>
            Close
          </Button>
        </div>
      </Modal>
    </div>
  );
}
