import { z } from 'zod';
import { Callsign } from './auth.js';

export const CheckInInput = z.object({
  callsign: Callsign,
  nameAtCheckIn: z.string().min(1).max(80),
  comment: z.string().max(500).nullable().optional(),
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
  createdById: z.string().nullable().optional(),
});
export type CheckIn = z.infer<typeof CheckIn>;
