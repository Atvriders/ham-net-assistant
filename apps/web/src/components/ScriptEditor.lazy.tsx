import React, { Suspense, lazy } from 'react';

interface Props {
  /** Current script value (markdown — or HTML for older docx imports). */
  value: string;
  /** Called with the markdown representation whenever the user edits. */
  onChange: (markdown: string) => void;
  /** Optional id used by the textarea in raw mode (for label association). */
  id?: string;
}

/**
 * Lazy entry point for the TipTap-backed `ScriptEditor`. The real editor pulls
 * in @tiptap/react, @tiptap/starter-kit, @tiptap/extension-link, and
 * tiptap-markdown — roughly 250-350 KB of JS that we don't want on the
 * initial bundle since most users never open a net-edit modal.
 *
 * While the chunk is in flight we render a plain `<textarea>` that mirrors
 * the same `value` / `onChange` contract so the surrounding form stays
 * usable. The textarea is also what assistive tech sees during the hand-off,
 * so the field never feels "frozen" while the editor loads.
 */
const LazyScriptEditor = lazy(() =>
  import('./ScriptEditor.js').then((m) => ({ default: m.ScriptEditor })),
);

function ScriptEditorFallback({ value, onChange, id }: Props) {
  return (
    <div
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        overflow: 'hidden',
        background: 'var(--color-bg, transparent)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          padding: '6px 10px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.08em',
          color: 'var(--color-fg-muted, #888)',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-bg-muted, transparent)',
        }}
      >
        {'// LOADING EDITOR'}
      </div>
      <textarea
        id={id}
        data-testid="script-raw"
        rows={10}
        className="hna-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          minHeight: 200,
          maxHeight: 400,
          width: '100%',
          border: 'none',
          borderRadius: 0,
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontSize: 13,
          lineHeight: 1.5,
          resize: 'vertical',
          padding: 12,
        }}
      />
    </div>
  );
}

export function ScriptEditor(props: Props) {
  return (
    <Suspense fallback={<ScriptEditorFallback {...props} />}>
      <LazyScriptEditor {...props} />
    </Suspense>
  );
}
