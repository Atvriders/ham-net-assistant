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
