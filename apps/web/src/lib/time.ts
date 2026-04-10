const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayName(d: number): string {
  return DAYS[d] ?? '?';
}

export function nextOccurrence(dayOfWeek: number, startLocal: string): Date {
  const [h, m] = startLocal.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  const diff = (dayOfWeek - now.getDay() + 7) % 7;
  target.setDate(now.getDate() + diff);
  target.setHours(h ?? 0, m ?? 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 7);
  return target;
}
