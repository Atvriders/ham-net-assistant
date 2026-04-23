import React, { useState } from 'react';
import mammothBase from 'mammoth';
import TurndownService from 'turndown';

// mammoth's type defs omit convertToMarkdown, which exists at runtime.
const mammoth = mammothBase as unknown as typeof mammothBase & {
  convertToMarkdown: (input: { arrayBuffer: ArrayBuffer }) =>
    Promise<{ value: string; messages: unknown[] }>;
};
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { apiFetch, ApiErrorException } from '../api/client.js';

type Tab = 'file' | 'url' | 'paste';

interface Props {
  open: boolean;
  onClose: () => void;
  onImport: (markdown: string, mode: 'replace' | 'append') => void;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

async function parseFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.md') || name.endsWith('.txt')) {
    return await file.text();
  }
  if (name.endsWith('.docx')) {
    const buf = await file.arrayBuffer();
    const result = await mammoth.convertToMarkdown({ arrayBuffer: buf });
    return result.value;
  }
  // Fallback: try as text
  return await file.text();
}

export function ScriptImportModal({ open, onClose, onImport }: Props) {
  const [tab, setTab] = useState<Tab>('file');
  const [url, setUrl] = useState('');
  const [html, setHtml] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setUrl('');
    setHtml('');
    setPreview(null);
    setErr(null);
    setBusy(false);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      const md = await parseFile(f);
      setPreview(md);
    } catch (ex) {
      setErr((ex as Error).message || 'Failed to parse file');
    } finally {
      setBusy(false);
    }
  }

  async function fetchUrl() {
    if (!url.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch<{ markdown: string; source: string }>(
        '/script-import/url',
        { method: 'POST', body: JSON.stringify({ url }) },
      );
      setPreview(res.markdown);
    } catch (ex) {
      setErr(ex instanceof ApiErrorException ? ex.payload.message : (ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function convertHtml() {
    if (!html.trim()) return;
    try {
      setPreview(turndown.turndown(html));
      setErr(null);
    } catch (ex) {
      setErr('Could not convert HTML');
    }
  }

  // Paste event on the HTML tab — grab text/html clipboard data if available
  function onHtmlPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const htmlClip = e.clipboardData.getData('text/html');
    if (htmlClip) {
      e.preventDefault();
      setHtml(htmlClip);
      try {
        setPreview(turndown.turndown(htmlClip));
        setErr(null);
      } catch {
        // fall through to plain paste
      }
    }
  }

  function commit(mode: 'replace' | 'append') {
    if (!preview) return;
    onImport(preview, mode);
    reset();
    onClose();
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }}>
      <div style={{ minWidth: 0, maxWidth: 640, width: '100%' }}>
        <h2 style={{ marginTop: 0 }}>Import script</h2>
        <div className="hna-flex-wrap" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Button variant={tab === 'file' ? 'primary' : 'secondary'} onClick={() => { setTab('file'); setPreview(null); }}>File</Button>
          <Button variant={tab === 'url' ? 'primary' : 'secondary'} onClick={() => { setTab('url'); setPreview(null); }}>From URL</Button>
          <Button variant={tab === 'paste' ? 'primary' : 'secondary'} onClick={() => { setTab('paste'); setPreview(null); }}>Paste rich text</Button>
        </div>

        {tab === 'file' && (
          <div>
            <input type="file" accept=".md,.txt,.docx,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={onFile} />
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>.md, .txt, or .docx</div>
          </div>
        )}

        {tab === 'url' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              placeholder="https://docs.google.com/document/d/... or any url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button onClick={fetchUrl} disabled={busy}>{busy ? 'Fetching…' : 'Fetch'}</Button>
          </div>
        )}

        {tab === 'paste' && (
          <div>
            <textarea
              className="hna-input"
              rows={8}
              placeholder="Paste HTML or rich text from Google Docs / Word / a web page…"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              onPaste={onHtmlPaste}
              style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 13 }}
            />
            <Button onClick={convertHtml} disabled={busy || !html.trim()} style={{ marginTop: 8 }}>Convert</Button>
          </div>
        )}

        {err && <div style={{ color: 'var(--color-danger)', marginTop: 8 }}>{err}</div>}

        {preview !== null && (
          <div style={{ marginTop: 16 }}>
            <div className="hna-label" style={{ marginBottom: 6 }}>Preview (markdown)</div>
            <textarea
              className="hna-input"
              readOnly
              value={preview}
              rows={12}
              style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 13, background: 'var(--color-bg-muted)' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Button onClick={() => commit('replace')}>Replace script</Button>
              <Button variant="secondary" onClick={() => commit('append')}>Append to script</Button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--color-border)' }}>
          <Button variant="secondary" onClick={() => { reset(); onClose(); }}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
