import React, { useEffect, useId, useMemo, useState } from 'react';
import type { NetScript, ScriptCategory } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Selected script's body is handed back to the parent via this callback. */
  onPick: (script: NetScript) => void;
  /**
   * Category preselected in the filter. When provided, the picker opens
   * filtered to this category but the user can switch to "all".
   */
  preferredCategory?: ScriptCategory;
}

type Filter = ScriptCategory | 'all';

/**
 * Picker modal for the saved-script library. Lists active scripts with a
 * title search and category filter; clicking "Use this script" returns the
 * full script to the parent so it can load the body into the editor.
 */
export function ScriptLibraryPicker({ open, onClose, onPick, preferredCategory }: Props) {
  const [filter, setFilter] = useState<Filter>(preferredCategory ?? 'all');
  const [query, setQuery] = useState('');
  const [scripts, setScripts] = useState<NetScript[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogTitleId = useId();

  useEffect(() => {
    if (open) {
      setFilter(preferredCategory ?? 'all');
      setQuery('');
    }
  }, [open, preferredCategory]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setScripts(null);
    const qs = filter === 'all' ? '' : `?category=${encodeURIComponent(filter)}`;
    apiFetch<NetScript[]>(`/scripts${qs}`)
      .then((rows) => {
        if (!cancelled) setScripts(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiErrorException ? e.payload.message : (e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, filter]);

  const filtered = useMemo(() => {
    if (!scripts) return [];
    const q = query.trim().toLowerCase();
    if (!q) return scripts;
    return scripts.filter((s) => s.title.toLowerCase().includes(q));
  }, [scripts, query]);

  return (
    <Modal open={open} onClose={onClose} titleId={dialogTitleId}>
      <div style={{ minWidth: 0, maxWidth: 640, width: '100%' }}>
        <h2 id={dialogTitleId} style={{ marginTop: 0 }}>
          Use a saved script
        </h2>
        <p style={{ fontSize: 13, opacity: 0.8, marginTop: 0 }}>
          Pick one of the saved scripts to load into this net&rsquo;s script
          field. The current editor content will be replaced.
        </p>

        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <label style={{ fontSize: 12, opacity: 0.8 }}>
            Category{' '}
            <select
              className="hna-input"
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
              style={{ marginLeft: 4 }}
            >
              <option value="all">All</option>
              <option value="weekly">Weekly</option>
              <option value="general">General</option>
              <option value="impromptu">Impromptu</option>
            </select>
          </label>
          <Input
            placeholder="Search by title…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: 160 }}
            aria-label="Search saved scripts"
          />
        </div>

        {/* The list simply stays empty when the fetch fails, so the error has
            to announce itself and be legible without colour. */}
        {error && (
          <div role="alert" className="hna-form-error">
            {error}
          </div>
        )}

        {scripts === null && !error && <div style={{ fontSize: 13 }}>Loading…</div>}

        {scripts !== null && filtered.length === 0 && !error && (
          <div style={{ fontSize: 13, fontStyle: 'italic', opacity: 0.7 }}>
            No saved scripts match.
          </div>
        )}

        {scripts !== null && filtered.length > 0 && (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxHeight: 360,
              overflowY: 'auto',
            }}
          >
            {filtered.map((s) => (
              <li
                key={s.id}
                style={{
                  padding: 10,
                  border: '1px solid var(--color-border)',
                  borderRadius: 6,
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{s.title}</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
                    {s.category}
                    {s.createdByCallsign ? ` · by ${s.createdByCallsign}` : ''}
                  </div>
                </div>
                <Button onClick={() => onPick(s)}>Use this script</Button>
              </li>
            ))}
          </ul>
        )}

        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 20,
            paddingTop: 14,
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
