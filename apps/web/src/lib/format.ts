/**
 * Display a callsign with slashed zeros (ham radio convention for distinguishing
 * 0 from O). Storage remains ASCII 0; this is display-only.
 */
export function displayCallsign(cs: string | null | undefined): string {
  if (!cs) return '';
  return cs.replace(/0/g, 'Ø');
}

export function formatFrequency(mhz: number): string {
  return `${mhz.toFixed(3)} MHz`;
}
export function formatOffset(khz: number): string {
  if (khz === 0) return 'simplex';
  const sign = khz > 0 ? '+' : '−';
  return `${sign}${Math.abs(khz)} kHz`;
}
export function formatTone(hz: number | null | undefined): string {
  return hz == null ? 'none' : `${hz.toFixed(1)} Hz`;
}

/**
 * Capitalize only the first character of a string, leaving the rest
 * unchanged. Empty strings pass through. Leading whitespace is preserved —
 * callers should trim first if they want the first non-space char capitalized.
 */
export function capitalizeFirst(s: string): string {
  if (!s) return '';
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Two tokens name the same machine if they agree to 1 kHz (145.41 == 145.410). */
const FREQ_EPSILON_MHZ = 0.001;

/** Bare integer/decimal runs — the candidate frequency tokens inside a name. */
const NUMERIC_TOKEN = /\d+(?:\.\d+)?/g;

/**
 * A unit the club may have typed after the number ("W0QQQ 145.410 MHz"). It is
 * swallowed with the token so the tidy pass is not left holding an orphaned
 * "MHz". Deliberately only "MHz" — "MC" would eat the initials in a name like
 * "145.410 MC Hall".
 */
const UNIT_SUFFIX = /^\s?mhz\b/i;

/** Punctuation a stripped token can leave stranded: "WØQQQ -", "· 145.41". */
const SEPARATOR_CLASS = '\\-\\u2013\\u2014\\u00b7,;:/|';
/** Leading/trailing debris once the token is gone. */
const EDGE_DEBRIS = new RegExp(`^[\\s${SEPARATOR_CLASS}]+|[\\s${SEPARATOR_CLASS}]+$`, 'g');
/** Separators that only had the stripped token between them: "Foo - - Bar". */
const DOUBLED_SEPARATOR = new RegExp(
  `\\s*([${SEPARATOR_CLASS}])(?:\\s*[${SEPARATOR_CLASS}])+\\s*`,
  'g',
);

/**
 * A numeric run only counts as a standalone frequency token when it is not
 * welded to letters or further digits — otherwise the "0" inside "W0QQQ" and
 * the "2" in "2m" would themselves be candidates for stripping.
 */
function isStandaloneToken(name: string, start: number, end: number): boolean {
  const before = start > 0 ? name[start - 1]! : '';
  const after = end < name.length ? name[end]! : '';
  if (before && /[\p{L}\d.]/u.test(before)) return false;
  // Letters after the digits only pass when they are the unit the number was
  // already wearing ("145.410 MHz"); anything else means the digits belong to
  // a word ("2m") and must not be touched.
  if (after && /[\p{L}\d]/u.test(after) && !UNIT_SUFFIX.test(name.slice(end))) return false;
  // A trailing "." only breaks the token when more digits follow it (the
  // regex would have consumed a real decimal), so "145.41." still strips.
  if (after === '.' && /\d/.test(name[end + 1] ?? '')) return false;
  return true;
}

/**
 * Drop a redundant frequency from a repeater's name.
 *
 * Clubs routinely name a machine after its output frequency ("W0QQQ 145.41")
 * and the console renders `name · frequency`, so the operator's status strip
 * read "W0QQQ 145.41 · 145.410 MHz" — the same number twice, in a strip whose
 * width is the scarcest thing on a phone. Only a token that parses to *this*
 * repeater's frequency (within {@link FREQ_EPSILON_MHZ}, so 145.41 ==
 * 145.410) is removed; an unrelated number in the name — "Mt Oread 146.94"
 * listed under a different output — survives untouched rather than being
 * silently mangled.
 *
 * Returns the original name whenever stripping would leave nothing behind: a
 * row labelled only "145.410 MHz" with no callsign is worse on the air than a
 * redundant one.
 */
export function repeaterDisplayName(name: string, frequencyMhz: number): string {
  if (!name || !Number.isFinite(frequencyMhz)) return name;

  let kept = '';
  let cursor = 0;
  let stripped = false;
  NUMERIC_TOKEN.lastIndex = 0;
  for (let m = NUMERIC_TOKEN.exec(name); m !== null; m = NUMERIC_TOKEN.exec(name)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isStandaloneToken(name, start, end)) continue;
    if (Math.abs(Number.parseFloat(m[0]) - frequencyMhz) >= FREQ_EPSILON_MHZ) continue;
    const unit = UNIT_SUFFIX.exec(name.slice(end));
    kept += name.slice(cursor, start);
    cursor = unit ? end + unit[0].length : end;
    stripped = true;
  }
  if (!stripped) return name;
  kept += name.slice(cursor);

  const tidied = kept
    // Brackets emptied by the removal: "W0QQQ (145.41)".
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ')
    .replace(DOUBLED_SEPARATOR, ' $1 ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_DEBRIS, '')
    .trim();

  return tidied.length > 0 ? tidied : name;
}
