/**
 * Format a single reminder lead time (in minutes) as a compact human label:
 * 30 -> "30m", 60 -> "1h", 90 -> "1h30m", 240 -> "4h", 1440 -> "1d", etc.
 */
export function formatReminderLeadCompact(minutes: number): string {
  if (minutes <= 0) return '0m';
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days}d`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins === 0 ? `${hours}h` : `${hours}h${mins}m`;
  }
  return `${minutes}m`;
}

/**
 * Format a list of reminder lead times (in minutes) as a friendly label
 * suitable for the nets list card. Returns "off" for the empty list.
 */
export function formatReminderMinutes(minutes: readonly number[] | null | undefined): string {
  if (!minutes || minutes.length === 0) return 'off';
  // Show earliest reminder first (largest lead).
  const sorted = [...minutes].sort((a, b) => b - a);
  return sorted.map(formatReminderLeadCompact).join(', ');
}
