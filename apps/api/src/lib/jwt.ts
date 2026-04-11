import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { Role } from '@hna/shared';

export interface JwtClaims {
  sub: string;
  role: Role;
}

const DAYS = 60 * 60 * 24;

export function signToken(claims: JwtClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: 7 * DAYS });
}

export function verifyToken(token: string): JwtClaims {
  const decoded = jwt.verify(token, env.JWT_SECRET);
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
  maxAge: 7 * DAYS * 1000,
  path: '/',
};
