import { z } from 'zod';

export const NetSessionUpdate = z.object({
  endedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  controlOpId: z.string().optional(),
  topicTitle: z.string().max(200).nullable().optional(),
});
export type NetSessionUpdate = z.infer<typeof NetSessionUpdate>;

export const NetSession = z.object({
  id: z.string(),
  netId: z.string(),
  startedAt: z.string().datetime(),
  /// Null while the session is in PREP (opened but not yet started). Set to
  /// the ISO timestamp when the control op presses START NET. The Discord
  /// "now live" notification fires at that transition, not at session-create.
  liveAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  controlOpId: z.string().nullable(),
  notes: z.string().nullable(),
  /// True when the server-side auto-open scheduler created this PREP session
  /// (~15 minutes before a weekly net's scheduled start). Operator-opened
  /// sessions are false. Defaults false for legacy rows.
  autoOpened: z.boolean().default(false),
});
export type NetSession = z.infer<typeof NetSession>;
