import type { CheckInMode } from '@hna/shared';

/**
 * Normalize the DB representation of a CheckIn's participation method into the
 * wire format the shared `CheckIn` zod schema validates against.
 *
 * The DB column is nullable (`mode TEXT NULL`) so historical rows stored
 * before the EchoLink feature shipped — and the common case of an operator
 * who didn't bother specifying — both come back as NULL. The wire format
 * promises a concrete enum value, defaulting NULL/unknown to 'rf' (the
 * FCC-friendly meaning: local repeater RF participation).
 */
export function normalizeCheckInMode(raw: string | null | undefined): CheckInMode {
  if (raw === 'echolink') return 'echolink';
  return 'rf';
}

/**
 * Lift the mode field on a single Prisma CheckIn row to the wire shape.
 * Returns a shallow copy with `mode` guaranteed to be a CheckInMode.
 */
export function withCheckInMode<T extends { mode?: string | null }>(
  ci: T,
): Omit<T, 'mode'> & { mode: CheckInMode } {
  return { ...ci, mode: normalizeCheckInMode(ci.mode) };
}
