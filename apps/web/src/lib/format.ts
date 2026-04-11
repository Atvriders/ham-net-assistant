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
