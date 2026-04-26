export interface ParsedSession {
  /** Local date the net occurred. We treat the time as 20:00 local. */
  date: Date;
  /** Source line for the date (for error reporting). */
  rawDateLine: string;
  topic: string | null;
  controlOp: { callsign: string; name: string } | null;
  checkIns: Array<{ callsign: string; name: string }>;
}

export interface ParseResult {
  sessions: ParsedSession[];
  errors: Array<{ block: string; reason: string }>;
}

export function parseLogText(text: string): ParseResult {
  const sessions: ParsedSession[] = [];
  const errors: ParseResult['errors'] = [];
  // Normalize line endings, trim, split on 2+ blank lines
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 1) continue;
    const dateLine = lines[0]!;
    const date = parseDate(dateLine);
    if (!date) {
      errors.push({ block, reason: `Could not parse date: "${dateLine}"` });
      continue;
    }
    let topic: string | null = null;
    let controlOp: ParsedSession['controlOp'] = null;
    const checkIns: ParsedSession['checkIns'] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      const topicMatch = /^Topic:\s*(.+)$/i.exec(line);
      const ctrlMatch = /^NET\s+control:\s*(?:\(none\)|([A-Z0-9/]{3,10})\s+(.+))$/i.exec(line);
      if (topicMatch) {
        topic = topicMatch[1]!.trim();
        continue;
      }
      if (ctrlMatch) {
        if (ctrlMatch[1] && ctrlMatch[2]) {
          controlOp = {
            callsign: ctrlMatch[1].toUpperCase(),
            name: ctrlMatch[2].trim(),
          };
        }
        continue;
      }
      // Strip leading bullet glyphs (dot, bullet, asterisk, dash, digits) some users paste from rich text
      const cleaned = line.replace(/^[•●*\-\d+.\s]+/, '').trim();
      const ciMatch = /^([A-Z0-9/]{3,10})\s+(.+)$/i.exec(cleaned);
      if (ciMatch) {
        checkIns.push({
          callsign: ciMatch[1]!.toUpperCase(),
          name: ciMatch[2]!.trim(),
        });
        continue;
      }
      // Unparseable line — record error but don't fail the whole block
      errors.push({ block, reason: `Could not parse line: "${line}"` });
    }
    sessions.push({ date, rawDateLine: dateLine, topic, controlOp, checkIns });
  }
  return { sessions, errors };
}

/**
 * Accept M/D/YY, M/D/YYYY, MM/DD/YY, MM/DD/YYYY, and ISO YYYY-MM-DD.
 * Returns a Date set to 20:00:00 local time on that day, which is a
 * reasonable default for evening nets. Returns null if unparseable.
 */
function parseDate(line: string): Date | null {
  const trimmed = line.trim();
  // ISO first
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    if (validDate(y, mo, d)) return new Date(y, mo - 1, d, 20, 0, 0);
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed);
  if (us) {
    const mo = Number(us[1]);
    const d = Number(us[2]);
    let y = Number(us[3]);
    if (y < 100) y += 2000; // 26 -> 2026
    if (validDate(y, mo, d)) return new Date(y, mo - 1, d, 20, 0, 0);
  }
  return null;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
