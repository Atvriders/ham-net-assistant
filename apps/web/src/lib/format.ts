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
