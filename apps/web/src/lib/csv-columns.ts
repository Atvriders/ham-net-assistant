import type { RepeaterInput } from '@hna/shared';

export interface ColumnMapping {
  name?: number;
  frequency?: number;
  offsetKhz?: number;
  duplex?: number;
  toneHz?: number;
  mode?: number;
  coverage?: number;
}

export interface DetectResult {
  mapping: ColumnMapping;
  sourceHint: 'chirp' | 'generic';
}

const NAME_HEADERS = ['name', 'label', 'description'];
const FREQ_HEADERS = ['frequency', 'output frequency', 'output', 'freq', 'rx', 'receive'];
const OFFSET_HEADERS = ['offset', 'offset (khz)', 'duplex offset'];
const DUPLEX_HEADERS = ['duplex', 'direction'];
const TONE_HEADERS = ['tone', 'pl', 'ctcss', 'ctcss tx', 'tone freq', 'rtonefreq', 'rtone freq'];
const MODE_HEADERS = ['mode'];
const COVERAGE_HEADERS = [
  'comment',
  'location',
  'coverage',
  'nearest city',
  'city',
  'notes',
];

function findHeader(headers: string[], candidates: string[]): number | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const cand of candidates) {
    const idx = lower.indexOf(cand);
    if (idx >= 0) return idx;
  }
  return undefined;
}

export function detectColumns(header: string[]): DetectResult {
  const lower = header.map((h) => h.trim().toLowerCase());
  const isChirp =
    lower.includes('location') && lower.includes('rtonefreq');

  const mapping: ColumnMapping = {
    name: findHeader(header, NAME_HEADERS),
    frequency: findHeader(header, FREQ_HEADERS),
    offsetKhz: findHeader(header, OFFSET_HEADERS),
    duplex: findHeader(header, DUPLEX_HEADERS),
    toneHz: findHeader(header, TONE_HEADERS),
    mode: findHeader(header, MODE_HEADERS),
    coverage: findHeader(header, COVERAGE_HEADERS),
  };

  return { mapping, sourceHint: isChirp ? 'chirp' : 'generic' };
}

export interface BuiltRow {
  raw: string[];
  data: RepeaterInput;
  include: boolean;
  error?: string;
}

const VALID_MODES: ReadonlyArray<RepeaterInput['mode']> = ['FM', 'DMR', 'D-STAR', 'Fusion'];

function normalizeMode(value: string | undefined): RepeaterInput['mode'] {
  if (!value) return 'FM';
  const v = value.trim().toUpperCase();
  if (v === 'FM' || v === 'NFM' || v === 'WFM') return 'FM';
  if (v === 'DMR') return 'DMR';
  if (v === 'D-STAR' || v === 'DSTAR' || v === 'DV') return 'D-STAR';
  if (v === 'FUSION' || v === 'C4FM' || v === 'YSF') return 'Fusion';
  if (VALID_MODES.includes(v as RepeaterInput['mode'])) {
    return v as RepeaterInput['mode'];
  }
  return 'FM';
}

function parseTone(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || /^(off|none)$/i.test(trimmed)) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function parseOffsetKhz(
  offsetRaw: string | undefined,
  duplexRaw: string | undefined,
  sourceHint: 'chirp' | 'generic',
): number {
  if (!offsetRaw) return 0;
  const trimmed = offsetRaw.trim();
  if (!trimmed) return 0;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return 0;

  // CHIRP offset is in MHz; convert to kHz
  let khz: number;
  if (sourceHint === 'chirp') {
    khz = Math.round(num * 1000);
  } else {
    // If absolute value < 20, assume MHz; else kHz already
    khz = Math.abs(num) < 20 ? Math.round(num * 1000) : Math.round(num);
  }

  const duplex = (duplexRaw ?? '').trim().toLowerCase();
  if (duplex === '-') return -Math.abs(khz);
  if (duplex === '+') return Math.abs(khz);
  if (duplex === '' || duplex === 'off' || duplex === 'simplex') {
    return duplex === 'off' || duplex === 'simplex' ? 0 : khz;
  }
  return khz;
}

export function buildRows(
  headerMapping: ColumnMapping,
  dataRows: string[][],
  sourceHint: 'chirp' | 'generic',
): BuiltRow[] {
  return dataRows.map((raw): BuiltRow => {
    const get = (idx: number | undefined): string | undefined =>
      idx === undefined ? undefined : raw[idx];

    const freqStr = get(headerMapping.frequency);
    const frequency = freqStr ? Number(freqStr.trim()) : NaN;
    const freqValid = Number.isFinite(frequency) && frequency >= 1 && frequency <= 2000;

    const offsetKhz = parseOffsetKhz(
      get(headerMapping.offsetKhz),
      get(headerMapping.duplex),
      sourceHint,
    );

    const toneHz = parseTone(get(headerMapping.toneHz));
    const mode = normalizeMode(get(headerMapping.mode));

    let name = (get(headerMapping.name) ?? '').trim();
    if (!name) {
      const cov = (get(headerMapping.coverage) ?? '').trim();
      const callsign = cov.match(/\b([A-Z]{1,2}[0-9][A-Z]{1,3})\b/i);
      if (callsign && callsign[1]) {
        name = callsign[1].toUpperCase();
      } else if (freqValid) {
        name = `${frequency.toFixed(3)} MHz`;
      } else {
        name = 'Imported repeater';
      }
    }

    const coverageRaw = (get(headerMapping.coverage) ?? '').trim();
    const coverage = coverageRaw === '' ? null : coverageRaw;

    const data: RepeaterInput = {
      name: name.slice(0, 120),
      frequency: freqValid ? frequency : 0,
      offsetKhz,
      toneHz,
      mode,
      coverage,
      latitude: null,
      longitude: null,
    };

    return {
      raw,
      data,
      include: freqValid,
      error: freqValid ? undefined : 'Invalid frequency',
    };
  });
}
