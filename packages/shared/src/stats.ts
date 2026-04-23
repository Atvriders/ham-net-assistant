import { z } from 'zod';

export const StatsQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type StatsQuery = z.infer<typeof StatsQuery>;

export const ParticipationStats = z.object({
  range: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
  totalSessions: z.number().int(),
  totalCheckIns: z.number().int(),
  perMember: z.array(
    z.object({ callsign: z.string(), name: z.string(), count: z.number().int() }),
  ),
  perNet: z.array(
    z.object({ netId: z.string(), netName: z.string(), sessions: z.number().int(), checkIns: z.number().int() }),
  ),
  sessions: z.array(
    z.object({
      id: z.string(),
      netId: z.string(),
      netName: z.string(),
      startedAt: z.string().datetime(),
      endedAt: z.string().datetime().nullable(),
      topic: z.string().nullable(),
      controlOp: z.object({ callsign: z.string(), name: z.string() }).nullable(),
      checkIns: z.array(
        z.object({
          callsign: z.string(),
          name: z.string(),
          checkedInAt: z.string().datetime(),
        }),
      ),
    }),
  ),
});
export type ParticipationStats = z.infer<typeof ParticipationStats>;
