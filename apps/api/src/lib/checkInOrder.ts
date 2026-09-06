import type { Prisma } from '@prisma/client';

/**
 * How a session's check-in LOG is ordered.
 *
 * `sequence` is the order stations were heard — which an operator can correct
 * after the fact, because a station missed on the air gets typed in late.
 * `checkedInAt` is only the tiebreak, for rows written before the column
 * existed or by two inserts in the same millisecond.
 *
 * Exported as one constant rather than repeated at each call site: the log is
 * rendered by the run-net console, the session summary, the CSV and the PDF,
 * and a reorder that showed up in three of those four would be worse than no
 * reorder at all.
 *
 * NOT for "the most recent check-in" — undo, the callsign-history lookup and
 * the stale-session reaper all mean the latest by TIME, and must keep asking
 * for that.
 */
export const CHECKIN_LOG_ORDER_ASC: Prisma.CheckInOrderByWithRelationInput[] = [
  { sequence: 'asc' },
  { checkedInAt: 'asc' },
  { id: 'asc' },
];

/** The same order, newest first — the shape the session payloads return. */
export const CHECKIN_LOG_ORDER_DESC: Prisma.CheckInOrderByWithRelationInput[] = [
  { sequence: 'desc' },
  { checkedInAt: 'desc' },
  { id: 'desc' },
];
