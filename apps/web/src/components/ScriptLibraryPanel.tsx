import React, { useEffect, useId, useState } from 'react';
import type { NetScript, ScriptCategory } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Card } from './ui/Card.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { Modal } from './ui/Modal.js';
import { ConfirmModal } from './ui/ConfirmModal.js';
import { ScriptEditor } from './ScriptEditor.lazy.js';

const CATEGORIES: ScriptCategory[] = ['weekly', 'general', 'impromptu'];

interface EditState {
  id: string | null; // null = creating
  title: string;
  category: ScriptCategory;
  body: string;
}

/**
 * Officer-only panel listing saved scripts in the reusable script library
 * with minimal CRUD: rename / recategorize / edit body / delete (soft).
 * Mounted from AdminPage so officers and admins manage the library from one
 * place; renders nothing for members.
 */
export function ScriptLibraryPanel() {
  const { user } = useAuth();
  const canEdit = user?.role === 'OFFICER' || user?.role === 'ADMIN';
  const [scripts, setScripts] = useState<NetScript[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Pending soft-delete awaiting user confirmation. The ConfirmModal surfaces
  // the same prompt that window.confirm() previously showed.
  const [pendingDelete, setPendingDelete] = useState<NetScript | null>(null);
  const titleId = useId();
  const categoryId = useId();
  const bodyId = useId();
  const dialogTitleId = useId();

  async function refresh(): Promise<void> {
    try {
      const rows = await apiFetch<NetScript[]>('/scripts');
      setScripts(rows);
    } catch (e) {
      setError(e instanceof ApiErrorException ? e.payload.message : (e as Error).message);
    }
  }

  useEffect(() => {
    if (!canEdit) return;
    void refresh();
  }, [canEdit]);

  if (!canEdit) return null;

  function startCreate(): void {
    setSaveError(null);
    setEdit({ id: null, title: '', category: 'general', body: '' });
  }

  function startEdit(s: NetScript): void {
    setSaveError(null);
    setEdit({ id: s.id, title: s.title, category: s.category, body: s.body });
  }

  async function saveEdit(): Promise<void> {
    if (!edit) return;
    const title = edit.title.trim();
    if (!title) {
      setSaveError('Title is required.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (edit.id) {
        await apiFetch(`/scripts/${edit.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ title, category: edit.category, body: edit.body }),
        });
      } else {
        await apiFetch('/scripts', {
          method: 'POST',
          body: JSON.stringify({ title, category: edit.category, body: edit.body }),
        });
      }
      setEdit(null);
      await refresh();
    } catch (e) {
      setSaveError(e instanceof ApiErrorException ? e.payload.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function performDelete(s: NetScript): Promise<void> {
    try {
      await apiFetch(`/scripts/${s.id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setError(e instanceof ApiErrorException ? e.payload.message : (e as Error).message);
    }
  }

  return (
    <>
      <Card>
        <h3>Script library</h3>
        <p style={{ fontSize: 13, opacity: 0.8 }}>
          Reusable scripts available to any net. When creating or editing a
          net, officers can pick one from this library instead of pasting the
          same boilerplate every time.
        </p>
        <div style={{ marginBottom: 12 }}>
          <Button onClick={startCreate}>New script</Button>
        </div>
        {error && <div style={{ color: 'var(--color-danger)' }}>{error}</div>}
        {scripts === null && !error && <div style={{ fontSize: 13 }}>Loading…</div>}
        {scripts !== null && scripts.length === 0 && (
          <div style={{ fontSize: 13, opacity: 0.7, fontStyle: 'italic' }}>
            No saved scripts yet.
          </div>
        )}
        {scripts !== null && scripts.length > 0 && (
          <div className="hna-table-scroll" style={{ overflowX: 'auto' }}>
            <table className="hna-log-table" style={{ minWidth: 520 }}>
              <caption className="sr-only">Saved scripts in the script library</caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Category</th>
                  <th scope="col">Author</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {scripts.map((s) => (
                  <tr key={s.id}>
                    <th scope="row" style={{ fontWeight: 600, textAlign: 'left' }}>
                      {s.title}
                    </th>
                    <td>
                      <span className="hna-chip">{s.category}</span>
                    </td>
                    <td
                      className="hna-mono"
                      style={{ fontSize: 12, color: 'var(--color-fg-muted)' }}
                    >
                      {s.createdByCallsign ?? '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Button variant="secondary" size="sm" onClick={() => startEdit(s)}>
                          Edit
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setPendingDelete(s)}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Modal
        open={edit !== null}
        onClose={() => setEdit(null)}
        size="wide"
        title={edit?.id ? 'Edit saved script' : 'New saved script'}
      >
        {edit && (
          <div>
            <h2 id={dialogTitleId} style={{ marginTop: 0 }}>
              {edit.id ? 'Edit saved script' : 'New saved script'}
            </h2>
            <div className="hna-form">
              <div className="hna-field">
                <label htmlFor={titleId}>Title</label>
                <Input
                  id={titleId}
                  value={edit.title}
                  onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                  placeholder="e.g. Weekly tech net — opening"
                />
              </div>
              <div className="hna-field">
                <label htmlFor={categoryId}>Category</label>
                <select
                  id={categoryId}
                  className="hna-input"
                  value={edit.category}
                  onChange={(e) =>
                    setEdit({ ...edit, category: e.target.value as ScriptCategory })
                  }
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="hna-field">
                <label htmlFor={bodyId}>Body</label>
                <ScriptEditor
                  id={bodyId}
                  value={edit.body}
                  onChange={(md) => setEdit({ ...edit, body: md })}
                />
              </div>
            </div>
            {saveError && (
              <div style={{ color: 'var(--color-danger)', marginTop: 8 }}>{saveError}</div>
            )}
            <div className="hna-modal-actions">
              <Button onClick={() => void saveEdit()} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setEdit(null)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete saved script"
        message={
          pendingDelete
            ? `Delete saved script "${pendingDelete.title}"? This cannot be undone from the UI.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void performDelete(target);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </>
  );
}
