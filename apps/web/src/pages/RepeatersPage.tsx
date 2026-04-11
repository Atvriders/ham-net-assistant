import React, { useEffect, useState } from 'react';
import type { Repeater, RepeaterInput } from '@hna/shared';
import { apiFetch, ApiErrorException, isAbortError } from '../api/client.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Modal } from '../components/ui/Modal.js';
import { useAuth } from '../auth/AuthProvider.js';

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

  const [list, setList] = useState<Repeater[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [editing, setEditing] = useState<Repeater | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<RepeaterInput>(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const [suggesting, setSuggesting] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<RepeaterInput[]>([]);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [addingAll, setAddingAll] = useState(false);

  async function reload(signal?: AbortSignal) {
    const rows = await apiFetch<Repeater[]>('/repeaters', { signal });
    setList(rows);
  }

  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal).catch((e) => {
      if (!isAbortError(e)) setErr('Failed to load repeaters');
    });
    return () => ctrl.abort();
  }, []);

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

  async function discoverLocal() {
    if (!user?.callsign) return;
    setSuggesting(true);
    setSuggestionError(null);
    setSuggestions([]);
    setSuggestionsOpen(true);
    try {
      const result = await apiFetch<{ suggestions: RepeaterInput[]; reason?: string }>(
        `/repeaters/suggestions?callsign=${encodeURIComponent(user.callsign)}`,
      );
      if (!result.suggestions || result.suggestions.length === 0) {
        const reason = result.reason;
        setSuggestionError(
          reason === 'no-location'
            ? 'Could not locate your callsign. Callook.info had no coordinates for you.'
            : reason === 'upstream-error'
              ? 'Repeaterbook.com is temporarily unreachable. Try again shortly.'
              : 'No nearby repeaters found.',
        );
      } else {
        setSuggestions(result.suggestions);
      }
    } catch (ex) {
      setSuggestionError(
        ex instanceof ApiErrorException ? ex.payload.message : 'Discovery failed',
      );
    } finally {
      setSuggesting(false);
    }
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
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ flex: 1 }}>Repeaters</h1>
        {isOfficer && (
          <>
            <Button variant="secondary" onClick={discoverLocal} disabled={suggesting}>
              {suggesting ? 'Discovering…' : 'Discover local repeaters'}
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

      <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        {list.length === 0 && <p>No repeaters yet.</p>}
        {list.map((r) => (
          <Card key={r.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <RepeaterDetails r={r} />
              {isOfficer && (
                <div style={{ display: 'flex', gap: 8 }}>
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

      <Modal open={showForm} onClose={() => setShowForm(false)}>
        <h2>{editing ? 'Edit repeater' : 'Add repeater'}</h2>
        <form onSubmit={submitForm}>
          <label>
            Name
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            Frequency (MHz)
            <Input
              type="number"
              step="0.001"
              value={form.frequency}
              onChange={(e) => setForm({ ...form, frequency: Number(e.target.value) })}
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            Offset (kHz)
            <Input
              type="number"
              value={form.offsetKhz}
              onChange={(e) => setForm({ ...form, offsetKhz: Number(e.target.value) })}
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            Tone (Hz)
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
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            Mode
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
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            Coverage
            <Input
              value={form.coverage ?? ''}
              onChange={(e) =>
                setForm({ ...form, coverage: e.target.value || null })
              }
            />
          </label>
          {formErr && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 8 }}>
              {formErr}
            </div>
          )}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
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
            <div style={{ display: 'grid', gap: 8, maxHeight: 400, overflowY: 'auto' }}>
              {suggestions.map((s, i) => (
                <Card key={`${s.name}-${i}`}>
                  <div
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
