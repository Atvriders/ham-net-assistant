import { describe, it, expect } from 'vitest';
import { detectColumns, buildRows } from './csv-columns.js';

describe('detectColumns', () => {
  it('detects CHIRP format from Location + rToneFreq headers', () => {
    const header = [
      'Location',
      'Name',
      'Frequency',
      'Duplex',
      'Offset',
      'Tone',
      'rToneFreq',
      'cToneFreq',
      'DtcsCode',
      'DtcsPolarity',
      'Mode',
      'TStep',
      'Skip',
      'Comment',
    ];
    const result = detectColumns(header);
    expect(result.sourceHint).toBe('chirp');
    expect(result.mapping.name).toBe(1);
    expect(result.mapping.frequency).toBe(2);
    expect(result.mapping.duplex).toBe(3);
    expect(result.mapping.offsetKhz).toBe(4);
    expect(result.mapping.mode).toBe(10);
    expect(result.mapping.coverage).toBe(13);
  });

  it('returns generic hint for simple headers', () => {
    const result = detectColumns(['name', 'freq', 'tone']);
    expect(result.sourceHint).toBe('generic');
    expect(result.mapping.name).toBe(0);
    expect(result.mapping.frequency).toBe(1);
    expect(result.mapping.toneHz).toBe(2);
  });
});

describe('buildRows', () => {
  const chirpHeader = [
    'Location',
    'Name',
    'Frequency',
    'Duplex',
    'Offset',
    'Tone',
    'rToneFreq',
    'cToneFreq',
    'DtcsCode',
    'DtcsPolarity',
    'Mode',
    'TStep',
    'Skip',
    'Comment',
  ];

  it('builds positive offsetKhz for + duplex and 0.600000 MHz offset (CHIRP)', () => {
    const { mapping, sourceHint } = detectColumns(chirpHeader);
    const rows = buildRows(
      mapping,
      [['0', 'KS0MAN', '146.940', '+', '0.600000', '', '88.5', '88.5', '', '', 'FM', '', '', 'Manhattan']],
      sourceHint,
    );
    expect(rows[0]!.data.offsetKhz).toBe(600);
    expect(rows[0]!.data.frequency).toBeCloseTo(146.94, 3);
    expect(rows[0]!.data.name).toBe('KS0MAN');
    expect(rows[0]!.include).toBe(true);
  });

  it('builds negative offsetKhz for - duplex', () => {
    const { mapping, sourceHint } = detectColumns(chirpHeader);
    const rows = buildRows(
      mapping,
      [['0', 'N0CALL', '444.100', '-', '5.000000', '', '88.5', '88.5', '', '', 'FM', '', '', '']],
      sourceHint,
    );
    expect(rows[0]!.data.offsetKhz).toBe(-5000);
  });

  it('maps tone column correctly for generic header', () => {
    const { mapping, sourceHint } = detectColumns(['name', 'frequency', 'tone']);
    const rows = buildRows(mapping, [['W0ABC', '147.000', '88.5']], sourceHint);
    expect(rows[0]!.data.toneHz).toBe(88.5);
  });

  it('marks rows with invalid frequency as excluded with error', () => {
    const { mapping, sourceHint } = detectColumns(['name', 'frequency']);
    const rows = buildRows(mapping, [['bad', 'notanumber']], sourceHint);
    expect(rows[0]!.include).toBe(false);
    expect(rows[0]!.error).toBe('Invalid frequency');
  });

  it('treats Off tone as null', () => {
    const { mapping, sourceHint } = detectColumns(['name', 'frequency', 'tone']);
    const rows = buildRows(mapping, [['W0ABC', '146.52', 'Off']], sourceHint);
    expect(rows[0]!.data.toneHz).toBeNull();
  });
});
