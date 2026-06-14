import { z } from 'zod';
import { Callsign } from './auth.js';

/**
 * Participation method recorded on a CheckIn. 'rf' is the default (local
 * repeater RF — the common case on the FCC-friendly log). 'echolink' marks a
 * VoIP check-in via EchoLink so the log can distinguish participation
 * method. The enum is extensible (future: 'allstar' | 'irlp') without a
 * schema migration because the underlying column is a plain string.
 */
export const CheckInMode = z.enum(['rf', 'echolink']);
export type CheckInMode = z.infer<typeof CheckInMode>;

export const CheckInInput = z.object({
  callsign: Callsign,
  nameAtCheckIn: z.string().min(1).max(80),
  comment: z.string().max(500).nullable().optional(),
  mode: CheckInMode.optional(),
});
export type CheckInInput = z.infer<typeof CheckInInput>;

export const CheckIn = z.object({
  id: z.string(),
  sessionId: z.string(),
  userId: z.string().nullable(),
  callsign: Callsign,
  nameAtCheckIn: z.string(),
  checkedInAt: z.string().datetime(),
  comment: z.string().nullable(),
  /// Null in the DB → 'rf' on the wire. The API normalizes before returning
  /// so consumers can rely on a concrete enum value.
  mode: CheckInMode,
  createdById: z.string().nullable().optional(),
});
export type CheckIn = z.infer<typeof CheckIn>;
