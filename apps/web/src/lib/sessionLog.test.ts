import { describe, it, expect } from 'vitest';
import { buildSessionLogText } from './sessionLog.js';

describe('buildSessionLogText EchoLink suffix', () => {
  it("appends ' (EchoLink)' to rows where mode is 'echolink' and leaves RF rows quiet", () => {
    const text = buildSessionLogText({
      startedAt: '2026-06-13T00:00:00.000Z',
      topic: null,
      controlOp: null,
      checkIns: [
        {
          callsign: 'KE0RF1',
          name: 'Jeff',
          checkedInAt: '2026-06-13T00:01:00.000Z',
          mode: 'rf',
        },
        {
          callsign: 'KE0VOIP',
          name: 'Joe',
          checkedInAt: '2026-06-13T00:02:00.000Z',
          mode: 'echolink',
        },
      ],
    });
    expect(text).toContain('● KE0RF1 Jeff');
    // RF rows should NOT carry the EchoLink tag (keeps the common case quiet).
    expect(text).not.toContain('KE0RF1 Jeff (EchoLink)');
    expect(text).toContain('● KE0VOIP Joe (EchoLink)');
  });

  it("treats null / undefined mode as RF (no suffix) for legacy rows", () => {
    const text = buildSessionLogText({
      startedAt: '2026-06-13T00:00:00.000Z',
      topic: null,
      controlOp: null,
      checkIns: [
        {
          callsign: 'KE0OLD',
          name: 'Legacy',
          checkedInAt: '2026-06-13T00:01:00.000Z',
        },
      ],
    });
    expect(text).toContain('● KE0OLD Legacy');
    expect(text).not.toContain('(EchoLink)');
  });
});
