import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import TurndownService from 'turndown';
import { looksLikeHtml } from '../lib/scriptFormat.js';

type Mode = 'wysiwyg' | 'raw';

interface Props {
  /** Current script value (markdown — or HTML for older docx imports). */
  value: string;
  /** Called with the markdown representation whenever the user edits. */
  onChange: (markdown: string) => void;
  /** Optional id used by the textarea in raw mode (for label association). */
  id?: string;
}

/**
 * Lazily-built Turndown instance — used once to convert legacy HTML script
 * content (e.g. mammoth output from .docx imports) into markdown so it can
 * be loaded into the TipTap WYSIWYG editor without garbling.
 */
function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
  });
  return td.turndown(html);
}

/**
 * Normalize the stored script value into markdown for the WYSIWYG editor.
 * Existing nets may have HTML stored in `scriptMd` (from .docx imports);
 * detect that case and convert it down to markdown so TipTap can parse it.
 */
function toMarkdown(value: string): string {
  if (!value) return '';
  if (looksLikeHtml(value)) return htmlToMarkdown(value);
  return value;
}

/**
 * Toolbar button used in the WYSIWYG mode. Keeps presentation in one place so
 * the active-state styling stays consistent across all toolbar entries.
 */
function ToolbarButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active ? 'true' : 'false'}
      onMouseDown={(e) => {
        // Prevent the editor losing focus on click so toggle commands apply
        // to the current selection rather than nothing.
        e.preventDefault();
      }}
      onClick={onClick}
      style={{
        padding: '4px 8px',
        borderRadius: 4,
        border: '1px solid var(--color-border)',
        background: active ? 'var(--color-accent, #5b8def)' : 'transparent',
        color: active ? '#fff' : 'inherit',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        minWidth: 28,
        lineHeight: 1.2,
      }}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div
      role="toolbar"
      aria-label="Script formatting toolbar"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        padding: 6,
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bg-elev, transparent)',
      }}
    >
      <ToolbarButton
        title="Bold (Ctrl+B)"
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton
        title="Italic (Ctrl+I)"
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton
        title="Heading 1"
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        H1
      </ToolbarButton>
      <ToolbarButton
        title="Heading 2"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        title="Bullet list"
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        &bull; List
      </ToolbarButton>
      <ToolbarButton
        title="Numbered list"
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1. List
      </ToolbarButton>
      <ToolbarButton
        title="Quote"
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        &ldquo; Quote
      </ToolbarButton>
      <ToolbarButton
        title="Link"
        active={editor.isActive('link')}
        onClick={() => {
          const previous = (editor.getAttributes('link').href as string | undefined) ?? '';
          // eslint-disable-next-line no-alert
          const url = window.prompt('Link URL', previous);
          if (url === null) return; // cancel
          if (url === '') {
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
            return;
          }
          editor
            .chain()
            .focus()
            .extendMarkRange('link')
            .setLink({ href: url })
            .run();
        }}
      >
        Link
      </ToolbarButton>
      <ToolbarButton
        title="Undo (Ctrl+Z)"
        onClick={() => editor.chain().focus().undo().run()}
      >
        Undo
      </ToolbarButton>
      <ToolbarButton
        title="Redo (Ctrl+Shift+Z)"
        onClick={() => editor.chain().focus().redo().run()}
      >
        Redo
      </ToolbarButton>
    </div>
  );
}

/**
 * Script editor with a default WYSIWYG mode (TipTap) and a Raw markdown
 * fallback. Storage stays as markdown — `onChange` is always invoked with a
 * markdown string regardless of which mode is active.
 *
 * Mode is component-local only (no persisted user preference); the editor
 * always opens in human-readable mode.
 */
export function ScriptEditor({ value, onChange, id }: Props) {
  const [mode, setMode] = useState<Mode>('wysiwyg');

  // The "source of truth" for the editor is the markdown string in `value`.
  // We use a ref to suppress the onChange feedback loop that would otherwise
  // fire every time we programmatically set the editor content.
  const settingFromProp = useRef(false);

  // Initial content normalized to markdown — handles legacy HTML scripts.
  // Intentionally captured once on mount; subsequent `value` changes are
  // applied via the useEffect below to avoid resetting the editor on every
  // keystroke that flows back through `onChange`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialMarkdown = useMemo(() => toMarkdown(value), []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // We let StarterKit handle codeBlock, hardBreak, listItem, etc.
        // Heading levels limited to h1-h3 to keep the toolbar minimal.
        heading: { levels: [1, 2, 3] },
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: initialMarkdown,
    editorProps: {
      attributes: {
        class: 'hna-script-wysiwyg',
        'data-testid': 'script-wysiwyg',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (settingFromProp.current) return;
      const storage = ed.storage as unknown as {
        markdown: { getMarkdown: () => string };
      };
      const md = storage.markdown.getMarkdown();
      onChange(md);
    },
  });

  // Keep the editor in sync when `value` changes externally (e.g. the
  // ScriptImportModal replaces / appends content). We only push the change
  // into TipTap if it actually differs from the current markdown to avoid
  // resetting the user's cursor on every keystroke.
  useEffect(() => {
    if (!editor) return;
    const storage = editor.storage as unknown as {
      markdown: { getMarkdown: () => string };
    };
    const current = storage.markdown.getMarkdown();
    const next = toMarkdown(value);
    if (current === next) return;
    settingFromProp.current = true;
    editor.commands.setContent(next, { emitUpdate: false });
    settingFromProp.current = false;
  }, [value, editor]);

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
        role="tablist"
        aria-label="Script editor mode"
        style={{
          display: 'flex',
          gap: 0,
          padding: 6,
          background: 'var(--color-bg-muted, transparent)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'wysiwyg'}
          onClick={() => setMode('wysiwyg')}
          style={modeBtnStyle(mode === 'wysiwyg')}
        >
          Human readable
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'raw'}
          onClick={() => setMode('raw')}
          style={modeBtnStyle(mode === 'raw')}
        >
          Raw markdown
        </button>
      </div>

      {mode === 'wysiwyg' ? (
        <div>
          {editor && <Toolbar editor={editor} />}
          <div
            style={{
              minHeight: 200,
              maxHeight: 400,
              overflowY: 'auto',
              padding: 12,
              background: 'var(--color-bg-muted, transparent)',
            }}
          >
            <EditorContent editor={editor} />
            {editor && editor.isEmpty && (
              <div
                aria-hidden="true"
                style={{
                  pointerEvents: 'none',
                  position: 'relative',
                  marginTop: -editorPlaceholderOffset(),
                  color: 'var(--color-fg-muted, #888)',
                  fontStyle: 'italic',
                  fontSize: 14,
                }}
              >
                Type the net script here&hellip;
              </div>
            )}
          </div>
        </div>
      ) : (
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
      )}
    </div>
  );
}

function modeBtnStyle(active: boolean): React.CSSProperties {
  return {
    flex: '0 0 auto',
    padding: '4px 12px',
    borderRadius: 4,
    border: '1px solid var(--color-border)',
    background: active ? 'var(--color-accent, #5b8def)' : 'transparent',
    color: active ? '#fff' : 'inherit',
    cursor: 'pointer',
    fontSize: 12,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    fontWeight: 600,
    marginRight: 6,
  };
}

/**
 * Approximate vertical offset to position the empty-state placeholder back
 * over the (otherwise empty) first paragraph. Keeps the placeholder visually
 * inside the editor area without us needing a Placeholder extension dep.
 */
function editorPlaceholderOffset(): number {
  return 28;
}
