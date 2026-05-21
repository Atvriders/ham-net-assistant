import { z } from 'zod';

export const NetKind = z.enum(['weekly', 'impromptu']);
export type NetKind = z.infer<typeof NetKind>;

export const ScriptCategory = z.enum(['weekly', 'general', 'impromptu']);
export type ScriptCategory = z.infer<typeof ScriptCategory>;

/**
 * Default reminder lead times (in minutes-before-net-start) applied to a new
 * net when none are supplied. Matches the legacy global default of 4h + 30m.
 */
export const DEFAULT_REMINDER_MINUTES: readonly number[] = [240, 30] as const;

/**
 * Per-net reminder lead times. Each entry is a positive integer number of
 * minutes before the net's scheduled start at which to fire a reminder. An
 * empty array means "no reminders for this net". Capped at 10 entries; each
 * value is clamped 1..10080 (a week).
 */
export const ReminderMinutes = z
  .array(z.number().int().positive().max(10080))
  .max(10)
  .transform((arr) => {
    // Dedupe, sort descending (earliest reminder first chronologically), then
    // hand back a plain number[].
    const unique = Array.from(new Set(arr.map((n) => Math.floor(n))));
    unique.sort((a, b) => b - a);
    return unique;
  });
export type ReminderMinutes = z.infer<typeof ReminderMinutes>;

/**
 * Parse a stored JSON-encoded `reminderMinutes` column from the DB into a
 * sanitized `number[]`. Tolerant of nulls and malformed JSON so a bad row
 * never crashes the scheduler.
 */
export function parseReminderMinutes(raw: string | null | undefined): number[] {
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return ReminderMinutes.parse(parsed);
  } catch {
    return [];
  }
}

const baseNetFields = {
  name: z.string().min(1).max(120),
  repeaterId: z.string().min(1),
  theme: z.string().max(200).nullable().optional(),
  scriptMd: z.string().max(20000).nullable().optional(),
  scriptCategory: ScriptCategory.optional(),
  reminderMinutes: ReminderMinutes.optional(),
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
  reminderMinutes: z.array(z.number().int()).default([]),
  dayOfWeek: z.number().int(),
  startLocal: z.string(),
  timezone: z.string(),
  active: z.boolean(),
});
export type Net = z.infer<typeof Net>;
