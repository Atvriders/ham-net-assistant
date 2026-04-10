import { z } from 'zod';

export const Callsign = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{3,7}$/, 'Callsign must be 3–7 letters/digits');

export const Role = z.enum(['MEMBER', 'OFFICER', 'ADMIN']);
export type Role = z.infer<typeof Role>;

export const RegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80),
  callsign: Callsign,
  inviteCode: z.string().optional(),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const PublicUser = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  callsign: Callsign,
  role: Role,
  collegeSlug: z.string().nullable(),
});
export type PublicUser = z.infer<typeof PublicUser>;
