import { z } from 'zod';

export const Callsign = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^([A-Z0-9]{1,4}\/)?[A-Z0-9]{3,7}(\/(M|P|MM|AM|[A-Z0-9]{1,3}))?$|^N0CALL$/,
    'Invalid callsign format',
  );

export const Role = z.enum(['MEMBER', 'NET_CONTROL', 'OFFICER', 'ADMIN']);
export type Role = z.infer<typeof Role>;

/**
 * Numeric privilege rank for role comparisons — higher outranks lower.
 * NET_CONTROL sits BETWEEN MEMBER and OFFICER: it grants running a live net
 * (open/start/end a session, take & change control, manage check-ins and the
 * net topic, chat) but NO club-configuration access. Net/repeater/script CRUD,
 * stats, imports, and user/discord/theme administration all stay OFFICER/ADMIN.
 * Roles are stored as free-form strings in the DB, so this map — not a schema
 * migration — is what defines the ordering.
 */
export const ROLE_RANK: Record<Role, number> = {
  MEMBER: 0,
  NET_CONTROL: 1,
  OFFICER: 2,
  ADMIN: 3,
};

/** Human-readable role labels for UI display. */
export const ROLE_LABEL: Record<Role, string> = {
  MEMBER: 'Member',
  NET_CONTROL: 'Net Control',
  OFFICER: 'Officer',
  ADMIN: 'Admin',
};

/** True when `role` meets or exceeds the `min` required rank. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

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
