import React, { useState, type JSX } from 'react';
import type { RepeaterInput } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { parseCsv } from '../lib/csv-parse.js';
import { detectColumns, buildRows, type BuiltRow } from '../lib/csv-columns.js';

interface CsvImportModalProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

const MODES: ReadonlyArray<RepeaterInput['mode']> = ['FM', 'DMR', 'D-STAR', 'Fusion'];

export function CsvImportModal({
  open,
  onClose,
  onImported,
}: CsvImportModalProps): JSX.Element {
  const [rawText, setRawText] = useState('');
  const [rows, setRows] = useState<BuiltRow[]>([]);
  const [sourceHint, setSourceHint] = useState<'chirp' | 'generic' | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ success: number; errors: string[] } | null>(
    null,
  );

  function reset() {
    setRawText('');
    setRows([]);
    setSourceHint(null);
    setParseError(null);
    setBusy(false);
    setResult(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRawText(String(reader.result ?? ''));
    };
    reader.readAsText(file);
  }

  function handleParse() {
    setParseError(null);
    setResult(null);
    try {
      const parsed = parseCsv(rawText);
      if (parsed.length < 2) {
        setParseError('CSV must have a header row and at least one data row.');
        setRows([]);
        return;
      }
      const [header, ...data] = parsed;
      if (!header) {
        setParseError('CSV must have a header row and at least one data row.');
        setRows([]);
        return;
      }
      const { mapping, sourceHint: hint } = detectColumns(header);
      if (mapping.frequency === undefined) {
        setParseError(
          'Could not detect a frequency column. Expected a header like "Frequency", "Freq", or "RX".',
        );
        setRows([]);
        return;
      }
      const built = buildRows(mapping, data, hint);
      setRows(built);
      setSourceHint(hint);
    } catch (ex) {
      setParseError((ex as Error).message);
    }
  }

  function updateRow(idx: number, patch: Partial<BuiltRow['data']>) {
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx ? { ...r, data: { ...r.data, ...patch } } : r,
      ),
    );
  }

  function toggleRow(idx: number, include: boolean) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, include } : r)));
  }

  function setAll(include: boolean) {
    setRows((prev) => prev.map((r) => ({ ...r, include: include && !r.error })));
  }

  async function handleImport() {
    setBusy(true);
    setResult(null);
    const included = rows.filter((r) => r.include && !r.error);
    let ok = 0;
    const errs: string[] = [];
    for (const r of included) {
      try {
        await apiFetch('/repeaters', {
          method: 'POST',
          body: JSON.stringify(r.data),
        });
        ok += 1;
      } catch (e) {
        const message =
          e instanceof ApiErrorException ? e.payload.message : (e as Error).message;
        errs.push(`${r.data.name}: ${message}`);
      }
    }
    setResult({ success: ok, errors: errs });
    setBusy(false);
    onImported();
  }

  const cellStyle: React.CSSProperties = {
    padding: '4px 6px',
    borderBottom: '1px solid var(--color-border)',
    verticalAlign: 'top',
    fontSize: 12,
  };
  const headCellStyle: React.CSSProperties = {
    ...cellStyle,
    fontWeight: 600,
    textAlign: 'left',
    background: 'rgba(0,0,0,0.04)',
  };

  const includedCount = rows.filter((r) => r.include && !r.error).length;

  return (
    <Modal open={open} onClose={handleClose}>
      <h2>Import repeaters from CSV</h2>
      <p style={{ fontSize: 13, color: 'var(--color-border)' }}>
        Paste a CSV exported from CHIRP, RT Systems, or any spreadsheet. Column
        headers are auto-detected.
      </p>

      {rows.length === 0 && (
        <>
          <label style={{ display: 'block', marginTop: 8 }}>
            Upload CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              style={{ display: 'block', marginTop: 4 }}
            />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Or paste CSV text
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={10}
              style={{
                display: 'block',
                width: '100%',
                fontFamily: 'monospace',
                fontSize: 12,
                marginTop: 4,
                padding: 8,
                borderRadius: 4,
                border: '1px solid var(--color-border)',
                boxSizing: 'border-box',
              }}
              placeholder="Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,..."
            />
          </label>
          {parseError && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 8 }}>
              {parseError}
            </div>
          )}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Button onClick={handleParse} disabled={!rawText.trim()}>
              Parse
            </Button>
            <Button variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {rows.length > 0 && (
        <>
          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: 'var(--color-border)',
            }}
          >
            Detected format:{' '}
            <strong>{sourceHint === 'chirp' ? 'CHIRP export' : 'Generic CSV'}</strong>
            {' · '}
            {rows.length} row{rows.length === 1 ? '' : 's'} parsed, {includedCount}{' '}
            selected for import.
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => setAll(true)}>
              Select all
            </Button>
            <Button variant="secondary" onClick={() => setAll(false)}>
              Deselect all
            </Button>
          </div>
          <div
            className="hna-table-scroll"
            style={{
              marginTop: 8,
              maxHeight: 360,
              overflow: 'auto',
              border: '1px solid var(--color-border)',
              borderRadius: 4,
            }}
          >
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 800 }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>
                    <input
                      type="checkbox"
                      checked={includedCount === rows.filter((r) => !r.error).length && includedCount > 0}
                      onChange={(e) => setAll(e.target.checked)}
                      aria-label="Toggle all"
                    />
                  </th>
                  <th style={headCellStyle}>Name</th>
                  <th style={headCellStyle}>Freq (MHz)</th>
                  <th style={headCellStyle}>Offset (kHz)</th>
                  <th style={headCellStyle}>Tone</th>
                  <th style={headCellStyle}>Mode</th>
                  <th style={headCellStyle}>Coverage</th>
                  <th style={headCellStyle}>Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={idx}>
                    <td style={cellStyle}>
                      <input
                        type="checkbox"
                        checked={r.include}
                        disabled={!!r.error}
                        onChange={(e) => toggleRow(idx, e.target.checked)}
                        aria-label={`Include row ${idx + 1}`}
                      />
                    </td>
                    <td style={cellStyle}>
                      <Input
                        value={r.data.name}
                        onChange={(e) => updateRow(idx, { name: e.target.value })}
                      />
                    </td>
                    <td style={cellStyle}>
                      <Input
                        type="number"
                        step="0.001"
                        value={r.data.frequency}
                        onChange={(e) =>
                          updateRow(idx, { frequency: Number(e.target.value) })
                        }
                      />
                    </td>
                    <td style={cellStyle}>
                      <Input
                        type="number"
                        value={r.data.offsetKhz}
                        onChange={(e) =>
                          updateRow(idx, { offsetKhz: Number(e.target.value) })
                        }
                      />
                    </td>
                    <td style={cellStyle}>
                      <Input
                        type="number"
                        step="0.1"
                        value={r.data.toneHz ?? ''}
                        onChange={(e) =>
                          updateRow(idx, {
                            toneHz: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      />
                    </td>
                    <td style={cellStyle}>
                      <select
                        className="hna-input"
                        value={r.data.mode}
                        onChange={(e) =>
                          updateRow(idx, {
                            mode: e.target.value as RepeaterInput['mode'],
                          })
                        }
                      >
                        {MODES.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={cellStyle}>
                      <Input
                        value={r.data.coverage ?? ''}
                        onChange={(e) =>
                          updateRow(idx, { coverage: e.target.value || null })
                        }
                      />
                    </td>
                    <td style={{ ...cellStyle, color: 'var(--color-danger)' }}>
                      {r.error ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result && (
            <div
              role="status"
              style={{
                marginTop: 12,
                padding: 8,
                borderRadius: 4,
                background: 'rgba(0, 128, 0, 0.08)',
                border: '1px solid var(--color-border)',
              }}
            >
              Imported {result.success} repeater
              {result.success === 1 ? '' : 's'}.
              {result.errors.length > 0 && (
                <ul style={{ marginTop: 6, color: 'var(--color-danger)' }}>
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Button onClick={handleImport} disabled={busy || includedCount === 0}>
              {busy ? 'Importing…' : `Import selected (${includedCount})`}
            </Button>
            <Button variant="secondary" onClick={() => setRows([])} disabled={busy}>
              Back
            </Button>
            <Button variant="secondary" onClick={handleClose} disabled={busy}>
              Close
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
