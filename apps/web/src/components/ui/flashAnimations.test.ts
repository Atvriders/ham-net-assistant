/**
 * Blink budgets for the two run-net signal bars.
 *
 * The five-minute announcement shipped as `infinite`: a bar that blinks for
 * the entire five-minute window sits in the operator's peripheral vision while
 * they are reading the script on the air, and a permanent flash stops reading
 * as an alert at all. It is now a fixed five blinks that park on the solid
 * high-contrast frame, and the net-started confirmation is exactly one.
 *
 * Asserted against ui.css itself: jsdom never loads the stylesheet, so a
 * rendering test could not see the animation, and the iteration count is the
 * whole behaviour being specified here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolved from the vitest root (apps/web) — under jsdom `import.meta.url` is
// an http:// URL, not a file path.
// Comments stripped first: every rule below is commented, and a comment
// sitting between the selector and its `animation:` line would otherwise be
// parsed as part of the declaration.
const css = readFileSync(
  resolve(process.cwd(), 'src/components/ui/ui.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block for an exact selector (first match). */
function block(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at === -1) throw new Error(`selector not found in ui.css: ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** The `animation:` shorthand declared in a block. */
function animation(selector: string): string {
  const decl = block(selector)
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('animation:'));
  if (!decl) throw new Error(`no animation shorthand on ${selector}`);
  return decl.slice('animation:'.length).trim();
}

describe('run-net signal bars have bounded blink budgets', () => {
  it('the 5-minute announcement blinks exactly 5 times, then holds', () => {
    const anim = animation('.hna-fivemin');
    expect(anim).not.toContain('infinite');
    // Iteration count: the bare integer in the shorthand.
    expect(anim.split(/\s+/)).toContain('5');
    // Without `forwards` the bar would snap back to its low-contrast resting
    // style the instant the blinking stops, i.e. get QUIETER after alerting.
    expect(anim).toContain('forwards');
  });

  it('the net-started confirmation blinks exactly once', () => {
    const anim = animation('.hna-netstarted');
    expect(anim).not.toContain('infinite');
    expect(anim.split(/\s+/)).toContain('1');
    expect(anim).toContain('forwards');
  });

  it('both bars are held static under prefers-reduced-motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion'));
    for (const sel of ['.hna-fivemin', '.hna-netstarted']) {
      const at = reduced.indexOf(`${sel} {`);
      expect(at, `${sel} missing from the reduced-motion block`).toBeGreaterThan(-1);
      const body = reduced.slice(at, reduced.indexOf('}', at));
      expect(body).toContain('animation: none');
    }
  });
});
