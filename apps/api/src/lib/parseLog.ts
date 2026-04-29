export interface ParsedSession {
  /** Local date the net occurred. We treat the time as 20:00 local. */
  date: Date;
  /** Source line for the date (for error reporting). */
  rawDateLine: string;
  /** Trailing prose on the date line (e.g. "(2m rpt)"), or null. */
  notes: string | null;
  topic: string | null;
  /** Net control op. Name may be empty when only a callsign was recorded. */
  controlOp: { callsign: string; name: string } | null;
  /** Backup operators captured from `Backup:` lines (zero or more per session). */
  backups: Array<{ callsign: string; name: string }>;
  checkIns: Array<{ callsign: string; name: string }>;
}

export interface ParseResult {
  sessions: ParsedSession[];
  errors: Array<{ block: string; reason: string }>;
}

/**
 * Tolerant log parser. Walks lines top-to-bottom and uses a date line as the
 * only reliable session boundary. Anything between dates that doesn't match a
 * known structural line is silently associated with the current session as
 * background prose — we never fail a parse on a line we don't recognise.
 *
 * The previous block-based parser was too strict and emitted "could not parse
 * line" errors for any free-form prose in real club docs (announcements,
 * SkyWARN notes, section headers, etc.). The new model treats the doc as a
 * stream of mostly-prose with date anchors.
 */
export function parseLogText(text: string): ParseResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sessions: ParsedSession[] = [];
  const errors: ParseResult['errors'] = [];
  let current: ParsedSession | null = null;

  function commit() {
    if (current) sessions.push(current);
    current = null;
  }

  for (const rawLine of lines) {
    const stripped = stripBullets(rawLine).trim();
    if (!stripped) continue;

    // Anchor — a line whose first token parses as a date opens a new session.
    const dateMatch = matchDateAtStart(stripped);
    if (dateMatch) {
      commit();
      current = {
        date: dateMatch.date,
        rawDateLine: stripped,
        notes: dateMatch.trailing || null,
        topic: null,
        controlOp: null,
        backups: [],
        checkIns: [],
      };
      continue;
    }

    if (!current) {
      // Lines before the first date anchor are silently ignored (could be a
      // doc title, header, or pasted prelude).
      continue;
    }

    // Topic
    const topicMatch = /^Topic:\s*(.+)$/i.exec(stripped);
    if (topicMatch) {
      current.topic = topicMatch[1]!.trim();
      continue;
    }

    // Net control / Control alias. Name is optional. `(none)` means explicit empty.
    const ctrlMatch = /^(?:NET\s+control|Control):\s*(?:\(none\)|([A-Z0-9/]{3,14})(?:\s+(.+))?)$/i.exec(stripped);
    if (ctrlMatch) {
      if (ctrlMatch[1]) {
        current.controlOp = {
          callsign: ctrlMatch[1].toUpperCase(),
          name: (ctrlMatch[2] ?? '').trim(),
        };
      }
      continue;
    }

    // Backup: <stuff> — name optional, callsign found at either end.
    const backupMatch = /^Backup:\s*(.+)$/i.exec(stripped);
    if (backupMatch) {
      const inside = backupMatch[1]!.trim();
      const tokens = inside.split(/\s+/);
      const lastToken = tokens[tokens.length - 1];
      const firstToken = tokens[0];
      const lastIsCall = !!lastToken && /^[A-Z0-9/]{3,14}$/i.test(lastToken);
      const firstIsCall = !!firstToken && /^[A-Z0-9/]{3,14}$/i.test(firstToken);
      let callsign: string | null = null;
      let name = '';
      if (lastIsCall && tokens.length > 1) {
        callsign = lastToken!.toUpperCase();
        name = tokens.slice(0, -1).join(' ').trim();
      } else if (firstIsCall) {
        callsign = firstToken!.toUpperCase();
        name = tokens.slice(1).join(' ').trim();
      }
      if (callsign) current.backups.push({ callsign, name });
      continue;
    }

    // Section header — silently skip (`Check-ins:`, `Checkins:`, `Announcements`, etc.)
    if (/^(check[-\s]?ins?|announcements?|notes?|reminders?)\s*:?\s*$/i.test(stripped)) continue;

    // Callsign + name
    const ciNameMatch = /^([A-Z0-9/]{3,14})\s+(.+)$/i.exec(stripped);
    if (ciNameMatch && /[A-Z]/i.test(ciNameMatch[1]!) && /\d/.test(ciNameMatch[1]!)) {
      current.checkIns.push({
        callsign: ciNameMatch[1]!.toUpperCase(),
        name: ciNameMatch[2]!.trim(),
      });
      continue;
    }

    // Callsign only — must contain at least one letter and one digit to be a call.
    const ciAloneMatch = /^([A-Z0-9/]{3,14})$/i.exec(stripped);
    if (ciAloneMatch && /[A-Z]/i.test(ciAloneMatch[1]!) && /\d/.test(ciAloneMatch[1]!)) {
      current.checkIns.push({
        callsign: ciAloneMatch[1]!.toUpperCase(),
        name: '',
      });
      continue;
    }

    // Anything else: silently skip (announcement prose, etc.). We don't push
    // to `errors` — that channel is reserved for catastrophic failures, and
    // current rules have none.
  }
  commit();
  return { sessions, errors };
}

/**
 * Strip leading bullet glyphs and list markers some users paste from rich text.
 * Keep the rest verbatim. The `\d+\.` numbering case is also handled here.
 */
function stripBullets(s: string): string {
  return s
    .replace(/^[\s]*[•●◦▪·*\-–—]+\s*/u, '')
    .replace(/^\s*\d+\.\s+/, '');
}

interface DateAtStart { date: Date; trailing: string }

/**
 * Match a date at the start of `line`. Accepts ISO YYYY-MM-DD and US
 * M/D/YY[YY]. Tolerates the `3/28//26` doubled-slash typo. Captures any
 * trailing text (parenthetical or free-form) so the caller can store it as
 * session notes.
 */
function matchDateAtStart(line: string): DateAtStart | null {
  // Collapse multiple slashes ("3/28//26" -> "3/28/26") just for date matching.
  const cleaned = line.replace(/\/{2,}/g, '/');
  // ISO YYYY-MM-DD
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})\b\s*(.*)$/.exec(cleaned);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    if (validDate(y, mo, d)) {
      return { date: new Date(y, mo - 1, d, 20, 0, 0), trailing: iso[4]!.trim() };
    }
  }
  // US M/D/YY or M/D/YYYY
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b\s*(.*)$/.exec(cleaned);
  if (us) {
    const mo = Number(us[1]);
    const d = Number(us[2]);
    let y = Number(us[3]);
    if (y < 100) y += 2000; // 26 -> 2026
    if (validDate(y, mo, d)) {
      return { date: new Date(y, mo - 1, d, 20, 0, 0), trailing: us[4]!.trim() };
    }
  }
  return null;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
