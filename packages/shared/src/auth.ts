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

/**
 * Canonical email form for every *input* schema.
 *
 * SQLite's UNIQUE index on `User.email` is BINARY, so "Bob@X.com" and
 * "bob@x.com" are two different keys: without normalization the same person
 * can register twice and then "lose" their check-in history to whichever
 * casing they happened to type at login. Normalizing on the way in makes the
 * binary index behave like a case-insensitive one.
 *
 * `.max(254)` is the RFC 5321 ceiling for a full address. It matters here
 * because the JSON body limit is 1 MB — without a length cap a ~200 KB string
 * validated as an "email" and was persisted verbatim.
 *
 * Note this is deliberately NOT applied to `PublicUser` (an output schema):
 * responses echo whatever is stored so an operator sees the real DB value.
 */
export const Email = z.string().trim().toLowerCase().max(254).email();

/**
 * 12 chars, not 8. Password hashes never leave the server (argon2id), so the
 * realistic attack is online guessing against /auth/login, where club members
 * reusing a short dictionary password are the weak link. 12 is the shortest
 * floor that makes that guessing impractical when paired with the login rate
 * limiter in the API. The 128 ceiling bounds argon2 work per request.
 */
export const Password = z.string().min(12).max(128);

export const RegisterInput = z.object({
  email: Email,
  password: Password,
  name: z.string().min(1).max(80),
  callsign: Callsign,
  inviteCode: z.string().optional(),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  // Same normalization as registration — otherwise a member who registered as
  // "bob@x.com" could not sign in by typing "Bob@X.com".
  email: Email,
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
