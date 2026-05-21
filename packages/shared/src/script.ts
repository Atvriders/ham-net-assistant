import { z } from 'zod';
import { ScriptCategory } from './net.js';

/**
 * Create/update payload for a saved script in the reusable script library.
 * Body cap matches `Net.scriptMd` so a saved script can always be loaded
 * verbatim into a net's script field.
 */
export const NetScriptInput = z.object({
  title: z.string().trim().min(1).max(200),
  category: ScriptCategory.optional(),
  body: z.string().max(20000),
});
export type NetScriptInput = z.infer<typeof NetScriptInput>;

/**
 * Saved script as returned by the API. `createdBy*` fields are optional
 * because the original author may have been deleted (FK is SET NULL).
 */
export const NetScript = z.object({
  id: z.string(),
  title: z.string(),
  category: ScriptCategory,
  body: z.string(),
  createdById: z.string().nullable(),
  createdByCallsign: z.string().optional(),
  createdByName: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type NetScript = z.infer<typeof NetScript>;
