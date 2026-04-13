import { z } from 'zod';

export const NetSessionUpdate = z.object({
  endedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  controlOpId: z.string().optional(),
});
export type NetSessionUpdate = z.infer<typeof NetSessionUpdate>;

export const NetSession = z.object({
  id: z.string(),
  netId: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  controlOpId: z.string().nullable(),
  notes: z.string().nullable(),
});
export type NetSession = z.infer<typeof NetSession>;
