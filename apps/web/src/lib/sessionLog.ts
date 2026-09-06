interface SessionForLog {
  startedAt: string;
  topic: string | null;
  controlOp: { callsign: string; name: string } | null;
  checkIns: Array<{
    callsign: string;
    name: string;
    checkedInAt: string;
    mode?: 'rf' | 'echolink' | null;
  }>;
}

/**
 * Format a session as plain text for clipboard:
 *
 *   M/D/YY
 *   Topic: ...
 *   NET control: <CALL> <name>
 *   ● <CALL1> <name1>
 *   ● <CALL2> <name2> (EchoLink)
 *
 * Topic line is omitted when no topic. NET control line shows '(none)'
 * when no control op. Check-ins are rendered chronologically (oldest first)
 * with a bullet glyph, raw ASCII callsigns (no slashed-zero substitution).
 * EchoLink rows append ' (EchoLink)' to make participation method explicit
 * on the FCC-friendly log; RF (the default) renders quietly without a tag.
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
  // The API returns check-ins in log order (an operator's own ordering, then
  // check-in time). Re-sorting here by timestamp would make a copied log
  // disagree with the log on screen.
  for (const ci of s.checkIns) {
    const tag = ci.mode === 'echolink' ? ' (EchoLink)' : '';
    lines.push(`● ${ci.callsign} ${ci.name}${tag}`);
  }
  return lines.join('\n');
}
