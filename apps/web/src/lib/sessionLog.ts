interface SessionForLog {
  startedAt: string;
  topic: string | null;
  controlOp: { callsign: string; name: string } | null;
  checkIns: Array<{ callsign: string; name: string; checkedInAt: string }>;
}

/**
 * Format a session as plain text for clipboard:
 *
 *   M/D/YY
 *   Topic: ...
 *   NET control: <CALL> <name>
 *   ● <CALL1> <name1>
 *   ● <CALL2> <name2>
 *
 * Topic line is omitted when no topic. NET control line shows '(none)'
 * when no control op. Check-ins are rendered chronologically (oldest first)
 * with a bullet glyph, raw ASCII callsigns (no slashed-zero substitution).
 */
export function buildSessionLogText(s: SessionForLog): string {
  const date = new Date(s.startedAt).toLocaleDateString('en-US', {
    year: '2-digit',
    month: 'numeric',
    day: 'numeric',
  });
  const lines: string[] = [date];
  if (s.topic) lines.push(`Topic: ${s.topic}`);
  lines.push(
    `NET control: ${s.controlOp ? `${s.controlOp.callsign} ${s.controlOp.name}` : '(none)'}`,
  );
  const sorted = [...s.checkIns].sort(
    (a, b) => new Date(a.checkedInAt).getTime() - new Date(b.checkedInAt).getTime(),
  );
  for (const ci of sorted) {
    lines.push(`● ${ci.callsign} ${ci.name}`);
  }
  return lines.join('\n');
}
