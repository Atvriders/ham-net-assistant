import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { Role } from '@hna/shared';

export interface JwtClaims {
  sub: string;
  role: Role;
}

const HOURS = 60 * 60;

/**
 * Session lifetime, in seconds.
 *
 * 12h rather than the original 7 days: the cookie is the whole credential, so
 * a copy taken off a shared club laptop is a valid login for exactly this
 * long. Role changes and deletions no longer wait for expiry (`loadUser` reads
 * the user row on every request), but nothing can revoke a *stolen* cookie
 * without a schema change — bounding it is the mitigation. 12h also covers a
 * full net night without a mid-net re-login.
 */
export const TOKEN_TTL_SECONDS = 12 * HOURS;

export function signToken(claims: JwtClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: TOKEN_TTL_SECONDS,
    algorithm: 'HS256',
  });
}

export function verifyToken(token: string): JwtClaims {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  if (typeof decoded === 'string') throw new Error('Invalid token');
  const parsed = Role.safeParse((decoded as { role?: unknown }).role);
  if (!parsed.success) throw new Error('Invalid role claim');
  return { sub: String(decoded.sub), role: parsed.data };
}

export const COOKIE_NAME = 'hna_session';
export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  // Kept in lockstep with the token's own exp: a cookie that outlives its JWT
  // just produces silent 401s on every request until the user clears it.
  maxAge: TOKEN_TTL_SECONDS * 1000,
  path: '/',
};
