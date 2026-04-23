import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Repeater, RepeaterInput } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { useAutoFetch } from '../lib/useAutoFetch.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Modal } from '../components/ui/Modal.js';
import { useAuth } from '../auth/AuthProvider.js';
import { decodeGrid } from '../lib/grid.js';
import { CsvImportModal } from '../components/CsvImportModal.js';

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

function RepeaterDetails({ r }: { r: RepeaterInput }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{r.name}</div>
      <div style={{ fontSize: 13, color: 'var(--color-border)' }}>
        {r.frequency.toFixed(3)} MHz · offset {r.offsetKhz} kHz
        {r.toneHz ? ` · PL ${r.toneHz}` : ''} · {r.mode}
      </div>
      {r.coverage && (
        <div style={{ fontSize: 12, color: 'var(--color-border)' }}>{r.coverage}</div>
      )}
    </div>
  );
}

export function RepeatersPage() {
  const { user } = useAuth();
  const isOfficer = user?.role === 'OFFICER' || user?.role === 'ADMIN';

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

  async function del(id: string) {
    if (!confirm('Delete this repeater?')) return;
    await apiFetch(`/repeaters/${id}`, { method: 'DELETE' });
    await reload();
  }

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
    <div className="hna-container" style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ marginBottom: 12 }}>
        <Link to="/nets" style={{ color: 'var(--color-fg)', opacity: 0.7, fontSize: 13 }}>
          ← Back to nets
        </Link>
      </div>
      <div className="hna-flex-wrap" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ flex: 1 }}>Repeaters</h1>
        {isOfficer && (
          <>
            <Button variant="secondary" onClick={discoverLocal} disabled={suggesting}>
              {suggesting ? 'Discovering…' : 'Discover local repeaters'}
            </Button>
            <Button variant="secondary" onClick={openCoords} disabled={suggesting}>
              Discover by coordinates
            </Button>
            <Button variant="secondary" onClick={() => setCsvOpen(true)}>
              Import from CSV
            </Button>
            <Button onClick={openCreate}>Add repeater</Button>
          </>
        )}
      </div>

      {err && (
        <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 8 }}>
          {err}
        </div>
      )}

      {topAlert && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 6,
            border: '1px solid var(--color-danger)',
            color: 'var(--color-danger)',
            background: 'rgba(220, 53, 69, 0.08)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span>{topAlert}</span>
          <button
            type="button"
            onClick={() => setTopAlert(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className="hna-repeater-grid" style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        {list.length === 0 && <p>No repeaters yet.</p>}
        {list.map((r) => (
          <Card key={r.id}>
            <div className="hna-flex-wrap" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <RepeaterDetails r={r} />
              {isOfficer && (
                <div className="hna-flex-wrap" style={{ display: 'flex', gap: 8 }}>
                  <Button variant="secondary" onClick={() => openEdit(r)}>
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => del(r.id)}>
                    Delete
                  </Button>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>

      <CsvImportModal
        open={csvOpen}
        onClose={() => setCsvOpen(false)}
        onImported={() => {
          reload().catch(() => {});
        }}
      />

      <Modal open={showForm} onClose={() => setShowForm(false)}>
        <h2 style={{ marginTop: 0 }}>{editing ? 'Edit repeater' : 'Add repeater'}</h2>
        <form onSubmit={submitForm}>
          <div className="hna-form">
            <div className="hna-field">
              <label>Name</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="hna-field">
              <label>Frequency (MHz)</label>
              <Input
                type="number"
                step="0.001"
                value={form.frequency}
                onChange={(e) => setForm({ ...form, frequency: Number(e.target.value) })}
                required
              />
            </div>
            <div className="hna-field">
              <label>Offset (kHz)</label>
              <Input
                type="number"
                value={form.offsetKhz}
                onChange={(e) => setForm({ ...form, offsetKhz: Number(e.target.value) })}
                required
              />
            </div>
            <div className="hna-field">
              <label>Tone (Hz)</label>
              <Input
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
              <label>Mode</label>
              <select
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
              <label>Coverage</label>
              <Input
                value={form.coverage ?? ''}
                onChange={(e) =>
                  setForm({ ...form, coverage: e.target.value || null })
                }
              />
            </div>
          </div>
          {formErr && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 8 }}>
              {formErr}
            </div>
          )}
          <div className="hna-modal-actions">
            <Button type="submit" disabled={formBusy}>
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

      <Modal open={coordsOpen} onClose={() => setCoordsOpen(false)}>
        <h2>Discover by coordinates</h2>
        <form onSubmit={submitCoords}>
          <label style={{ display: 'block' }}>
            Grid square (Maidenhead)
            <div className="hna-flex-wrap" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Input
                value={coordGrid}
                onChange={(e) => handleGridChange(e.target.value)}
                placeholder="EM19jd"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={autofillGridFromCallsign}
                disabled={gridBusy || !user?.callsign}
              >
                {gridBusy ? 'Looking up…' : 'Auto-fill from callsign'}
              </Button>
            </div>
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            Latitude
            <Input
              type="number"
              step="0.0001"
              value={coordLat}
              onChange={(e) => setCoordLat(e.target.value)}
              placeholder="39.18"
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            Longitude
            <Input
              type="number"
              step="0.0001"
              value={coordLon}
              onChange={(e) => setCoordLon(e.target.value)}
              placeholder="-96.57"
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            Distance (miles, 1-100)
            <Input
              type="number"
              min={1}
              max={100}
              value={coordDist}
              onChange={(e) => setCoordDist(e.target.value)}
              required
            />
          </label>
          {coordErr && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 8 }}>
              {coordErr}
            </div>
          )}
          <div className="hna-flex-wrap" style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Button type="submit">Search</Button>
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

      <Modal open={suggestionsOpen} onClose={() => setSuggestionsOpen(false)}>
        <h2>Suggested repeaters near {user?.callsign ?? ''}</h2>
        {suggesting && <p>Loading…</p>}
        {suggestionError && (
          <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 8 }}>
            {suggestionError}
          </div>
        )}
        {!suggesting && suggestions.length > 0 && (
          <>
            <div style={{ marginBottom: 12 }}>
              <Button onClick={addAllSuggestions} disabled={addingAll}>
                {addingAll ? 'Adding…' : `Add all (${suggestions.length})`}
              </Button>
            </div>
            {suggestionSource && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-border)',
                  marginBottom: 8,
                }}
              >
                Source: {sourceLabel(suggestionSource)}
                {attemptedSources.length > 1 &&
                  ` (tried: ${attemptedSources.join(' → ')})`}
              </div>
            )}
            <div style={{ display: 'grid', gap: 8, maxHeight: 400, overflowY: 'auto' }}>
              {suggestions.map((s, i) => (
                <Card key={`${s.name}-${i}`}>
                  <div
                    className="hna-flex-wrap"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <RepeaterDetails r={s} />
                    <Button onClick={() => addSuggestion(i)}>Add</Button>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
        <div style={{ marginTop: 12 }}>
          <Button variant="secondary" onClick={() => setSuggestionsOpen(false)}>
            Close
          </Button>
        </div>
      </Modal>
    </div>
  );
}
