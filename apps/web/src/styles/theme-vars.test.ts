/**
 * Contrast floor for the text ramp in both palettes.
 *
 * The check-in ordinals (`.hna-roster__idx`) and the session-log index column
 * are painted in `--color-fg-subtle`, which shipped at 3.37:1 (dark) and
 * 3.84:1 (light) — under the WCAG AA 4.5:1 floor for normal text, on the one
 * column that tells an operator which check-in they are looking at. This test
 * pins the whole foreground ramp above the floor so a future palette tweak
 * can't quietly drop it back.
 *
 * Reads the token values straight out of theme-vars.css: the CSS is the source
 * of truth, and jsdom never loads it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolved from the vitest root (apps/web) — under the jsdom environment
// `import.meta.url` is an http:// URL, not a file path.
const css = readFileSync(
  resolve(process.cwd(), 'src/styles/theme-vars.css'),
  'utf8',
);

/** Grab the declaration block whose selector starts with `selector`. */
function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  return css.slice(open, close);
}

/** All `--token: #hex;` pairs in a declaration block. */
function hexTokens(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]!] = m[2]!.toLowerCase();
  }
  return out;
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG 2.x contrast ratio, 1..21. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const dark = hexTokens(block(':root {'));
const light = hexTokens(block("html[data-color-mode='light'] {"));

/** AA for normal text. The ordinals are 12px — no large-text exemption. */
const AA = 4.5;

// Backgrounds body text is actually painted on: the page, cards, and (dark
// only, where it differs enough to matter) the raised surface.
describe.each([
  ['dark', dark, ['--color-bg', '--color-surface', '--color-surface-2']],
  ['light', light, ['--color-bg', '--color-surface']],
] as const)('%s palette text ramp', (_name, tokens, backgrounds) => {
  it.each(['--color-fg', '--color-fg-muted', '--color-fg-subtle'])(
    '%s clears AA on every surface it is used on',
    (fgToken) => {
      const fg = tokens[fgToken];
      expect(fg, `${fgToken} missing`).toBeTruthy();
      for (const bgToken of backgrounds) {
        const bg = tokens[bgToken];
        expect(bg, `${bgToken} missing`).toBeTruthy();
        expect(
          contrast(fg!, bg!),
          `${fgToken} on ${bgToken}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    },
  );

  it('keeps the ramp ordered: fg is loudest, subtle is quietest', () => {
    const surface = tokens['--color-surface']!;
    const fg = contrast(tokens['--color-fg']!, surface);
    const muted = contrast(tokens['--color-fg-muted']!, surface);
    const subtle = contrast(tokens['--color-fg-subtle']!, surface);
    // Raising --color-fg-subtle to clear AA must not flatten the hierarchy
    // into "three shades of the same grey".
    expect(fg).toBeGreaterThan(muted);
    expect(muted).toBeGreaterThan(subtle);
  });
});
