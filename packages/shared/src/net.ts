import { z } from 'zod';

export const NetInput = z.object({
  name: z.string().min(1).max(120),
  repeaterId: z.string().min(1),
  dayOfWeek: z.number().int().gte(0).lte(6),
  startLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm'),
  timezone: z.string().min(1),
  theme: z.string().max(200).nullable().optional(),
  scriptMd: z.string().max(20000).nullable().optional(),
  active: z.boolean().optional(),
  linkedRepeaterIds: z.array(z.string()).max(30).optional(),
});
export type NetInput = z.infer<typeof NetInput>;

export const Net = NetInput.extend({
  id: z.string(),
  active: z.boolean(),
});
export type Net = z.infer<typeof Net>;
