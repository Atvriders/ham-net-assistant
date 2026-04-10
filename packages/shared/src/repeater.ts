import { z } from 'zod';

export const RepeaterMode = z.enum(['FM', 'DMR', 'D-STAR', 'Fusion']);

export const RepeaterInput = z.object({
  name: z.string().min(1).max(120),
  frequency: z.number().positive().max(2000),
  offsetKhz: z.number().int().gte(-10000).lte(10000),
  toneHz: z.number().positive().nullable().optional(),
  mode: RepeaterMode,
  coverage: z.string().max(1000).nullable().optional(),
  latitude: z.number().gte(-90).lte(90).nullable().optional(),
  longitude: z.number().gte(-180).lte(180).nullable().optional(),
});
export type RepeaterInput = z.infer<typeof RepeaterInput>;

export const Repeater = RepeaterInput.extend({
  id: z.string(),
  createdAt: z.string().datetime(),
});
export type Repeater = z.infer<typeof Repeater>;
