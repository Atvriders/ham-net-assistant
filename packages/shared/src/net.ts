import { z } from 'zod';

export const NetKind = z.enum(['weekly', 'impromptu']);
export type NetKind = z.infer<typeof NetKind>;

export const ScriptCategory = z.enum(['weekly', 'general', 'impromptu']);
export type ScriptCategory = z.infer<typeof ScriptCategory>;

const baseNetFields = {
  name: z.string().min(1).max(120),
  repeaterId: z.string().min(1),
  theme: z.string().max(200).nullable().optional(),
  scriptMd: z.string().max(20000).nullable().optional(),
  scriptCategory: ScriptCategory.optional(),
  active: z.boolean().optional(),
  linkedRepeaterIds: z.array(z.string()).max(30).optional(),
};

const dayOfWeek = z.number().int().gte(0).lte(6);
const startLocal = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm');

/**
 * Net create/update payload. Weekly nets require dayOfWeek/startLocal/timezone;
 * impromptu nets may omit them (the API substitutes scheduling sentinels).
 */
export const NetInput = z
  .object({
    ...baseNetFields,
    kind: NetKind.optional(),
    dayOfWeek: dayOfWeek.optional(),
    startLocal: startLocal.optional(),
    timezone: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.kind ?? 'weekly') === 'weekly') {
      if (val.dayOfWeek === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dayOfWeek'],
          message: 'Required for weekly nets',
        });
      }
      if (val.startLocal === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['startLocal'],
          message: 'Required for weekly nets',
        });
      }
      if (val.timezone === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['timezone'],
          message: 'Required for weekly nets',
        });
      }
    }
  });
export type NetInput = z.infer<typeof NetInput>;

export const Net = z.object({
  ...baseNetFields,
  id: z.string(),
  kind: NetKind,
  scriptCategory: ScriptCategory,
  dayOfWeek: z.number().int(),
  startLocal: z.string(),
  timezone: z.string(),
  active: z.boolean(),
});
export type Net = z.infer<typeof Net>;
