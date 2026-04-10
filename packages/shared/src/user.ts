import { z } from 'zod';
import { Role } from './auth.js';

export const UpdateMeInput = z.object({
  name: z.string().min(1).max(80).optional(),
  collegeSlug: z.string().max(40).nullable().optional(),
});
export type UpdateMeInput = z.infer<typeof UpdateMeInput>;

export const UpdateRoleInput = z.object({ role: Role });
export type UpdateRoleInput = z.infer<typeof UpdateRoleInput>;
