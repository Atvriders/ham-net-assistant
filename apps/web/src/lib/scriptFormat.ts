/**
 * Helpers for rendering script content that may be either HTML (from .docx
 * imports via mammoth) or markdown (the format the WYSIWYG editor saves).
 */
import MarkdownIt from 'markdown-it';

export function looksLikeHtml(s: string): boolean {
  return /<(p|h[1-6]|div|span|ul|ol|li|strong|em|br|table|td)[\s>]/i.test(s);
}

/**
 * markdown-it is the same engine `tiptap-markdown` (the WYSIWYG editor) uses
 * under the hood, so parsing a stored script with the same options keeps the
 * read-only render visually consistent with the "human readable" editor.
 *
 * - `html: false`  → literal HTML in the markdown is escaped (defense in depth;
 *                    DOMPurify still runs after this in SanitizedHtml).
 * - `linkify: true`→ bare URLs become links.
 * - `breaks: true` → single newlines become <br> so a net script reads
 *                    line-per-line the way operators expect.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/**
 * Turn a stored script value into HTML for read-only display.
 *
 * - Legacy HTML imports (mammoth/.docx, which embed inline font colors) are
 *   returned as-is so SanitizedHtml's DOMPurify pass can preserve their style
 *   attributes.
 * - Everything else is treated as markdown and rendered with markdown-it.
 *
 * The returned HTML is still expected to pass through DOMPurify (via
 * SanitizedHtml) before being inserted into the DOM.
 */
export function scriptToHtml(value: string): string {
  if (!value) return '';
  return looksLikeHtml(value) ? value : md.render(value);
}
