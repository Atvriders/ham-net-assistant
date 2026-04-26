import React, { useEffect, useState } from 'react';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { apiFetch, ApiErrorException } from '../api/client.js';

type Tab = 'paste' | 'url';

interface ImportSummary {
  parsed: Array<{
    rawDateLine: string;
    date: string;
    topic: string | null;
    controlOp: { callsign: string; name: string } | null;
    checkIns: Array<{ callsign: string; name: string }>;
  }>;
  errors: Array<{ block: string; reason: string }>;
  created: number;
  skipped: Array<{ rawDateLine: string; reason: string }>;
  sessionIds: string[];
}

interface NetOption { id: string; name: string }

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

export function LogImportModal({ open, onClose, onImported }: Props) {
  const [tab, setTab] = useState<Tab>('paste');
  const [nets, setNets] = useState<NetOption[]>([]);
  const [netId, setNetId] = useState<string>('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);

  useEffect(() => {
    if (!open) return;
    apiFetch<NetOption[]>('/nets').then((rows) => {
      setNets(rows);
      if (rows.length > 0 && !netId) setNetId(rows[0]!.id);
    }).catch(() => {});
  }, [open]);

  function reset() {
    setText(''); setUrl(''); setErr(null); setPreview(null); setBusy(false);
  }

  async function run(dryRun: boolean) {
    if (!netId) {
      setErr('Pick a Net to attach the imported sessions to.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      const path = tab === 'paste' ? '/log-import/text' : '/log-import/url';
      const body = tab === 'paste'
        ? { text, netId, dryRun }
        : { url, netId, dryRun };
      const res = await apiFetch<ImportSummary>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setPreview(res);
      if (!dryRun && res.created > 0) onImported();
    } catch (e) {
      setErr(e instanceof ApiErrorException ? e.payload.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }}>
      <div style={{ minWidth: 0, maxWidth: 720, width: '100%' }}>
        <h2 style={{ marginTop: 0 }}>Import historical net logs</h2>
        <div className="hna-field" style={{ marginBottom: 12 }}>
          <label>Attach to net</label>
          <select className="hna-input" value={netId} onChange={(e) => setNetId(e.target.value)}>
            {nets.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        </div>
        <div className="hna-flex-wrap" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Button variant={tab === 'paste' ? 'primary' : 'secondary'} onClick={() => { setTab('paste'); setPreview(null); }}>Paste text</Button>
          <Button variant={tab === 'url' ? 'primary' : 'secondary'} onClick={() => { setTab('url'); setPreview(null); }}>From URL</Button>
        </div>
        {tab === 'paste' && (
          <div className="hna-field">
            <label>Log text (blank lines separate sessions)</label>
            <textarea
              className="hna-input"
              rows={14}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'4/25/26\nTopic: ...\nNET control: AB0ZW James\nKC5QBT Jeff\nKF0WBD Bret\n\n5/2/26\n...'}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
            />
          </div>
        )}
        {tab === 'url' && (
          <div className="hna-field">
            <label>Google Docs (or plain text) URL</label>
            <Input
              placeholder="https://docs.google.com/document/d/.../edit"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
        )}
        {err && <div style={{ color: 'var(--color-danger)', marginTop: 8 }}>{err}</div>}
        {preview && (
          <div style={{ marginTop: 16, padding: 12, background: 'var(--color-bg-muted)', borderRadius: 6 }}>
            <div className="hna-label">Preview</div>
            <div style={{ marginTop: 6 }}>
              Parsed <strong>{preview.parsed.length}</strong> session(s).
              {' '}Created <strong>{preview.created}</strong>.
              {preview.skipped.length > 0 && <> Skipped <strong>{preview.skipped.length}</strong>.</>}
              {preview.errors.length > 0 && <> Errors: <strong>{preview.errors.length}</strong>.</>}
            </div>
            <ul style={{ marginTop: 8, fontSize: 13 }}>
              {preview.parsed.slice(0, 30).map((s, i) => (
                <li key={i}>
                  {new Date(s.date).toLocaleDateString('en-US', { year: '2-digit', month: 'numeric', day: 'numeric' })}
                  {' — '}{s.topic ?? '(no topic)'} — {s.checkIns.length} check-in(s)
                </li>
              ))}
            </ul>
            {preview.skipped.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary>Skipped</summary>
                <ul style={{ fontSize: 13 }}>
                  {preview.skipped.map((s, i) => <li key={i}>{s.rawDateLine}: {s.reason}</li>)}
                </ul>
              </details>
            )}
            {preview.errors.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary>Parse errors</summary>
                <ul style={{ fontSize: 13 }}>
                  {preview.errors.map((e, i) => <li key={i}>{e.reason}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
        <div className="hna-modal-actions">
          <Button onClick={() => run(false)} disabled={busy || !netId}>Import</Button>
          <Button variant="secondary" onClick={() => run(true)} disabled={busy || !netId}>Dry run</Button>
          <Button variant="secondary" onClick={() => { reset(); onClose(); }}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
