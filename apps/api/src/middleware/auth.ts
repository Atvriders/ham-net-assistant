import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import { ROLE_RANK, Role } from '@hna/shared';
import { verifyToken, COOKIE_NAME } from '../lib/jwt.js';
import { HttpError } from './error.js';

export interface AuthUser {
  id: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/**
 * Resolve the caller from the session cookie.
 *
 * The JWT only establishes *which* user is calling; the role always comes from
 * the database row. Trusting the `role` claim meant a cookie minted before a
 * demotion kept ADMIN powers for the rest of its lifetime, and a cookie copied
 * off a deleted member's browser kept working entirely — neither the admin
 * "change role" screen nor "delete user" actually revoked anything.
 *
 * Cost: one primary-key lookup per authenticated request. At this scale (a
 * club net is tens of users polling a few times a minute) that is a sub-
 * millisecond indexed hit on a local SQLite file, and it is the only thing
 * that makes role changes and deletions take effect immediately.
 */
export function loadUser(prisma: PrismaClient): RequestHandler {
  return (req, _res, next) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      next();
      return;
    }
    let sub: string;
    try {
      sub = verifyToken(token).sub;
    } catch {
      /* invalid/expired token → anonymous */
      next();
      return;
    }
    prisma.user
      .findUnique({ where: { id: sub }, select: { id: true, role: true } })
      .then((row) => {
        // No row → the account was deleted while the cookie was still valid.
        // Anonymous (not 401 here) so public routes keep working and gated
        // ones answer with the same 401 an expired cookie produces.
        if (!row) {
          next();
          return;
        }
        // `role` is a free-form string column, so a hand-edited or
        // partially-migrated row can hold something unrankable. Fail closed:
        // an unknown role must not compare as "at least MEMBER".
        const role = Role.safeParse(row.role);
        if (role.success) req.user = { id: row.id, role: role.data };
        next();
      })
      // A database fault must surface as a 500, not as a silent logout that
      // sends every operator back to the login screen mid-net.
      .catch(next);
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
  next();
};

// Rank-based (not string-equality) gate. A NET_CONTROL user passes
// requireRole('NET_CONTROL') and requireRole('MEMBER') but fails
// requireRole('OFFICER'); officers/admins outrank NET_CONTROL and pass it.
// Ordering lives in the shared ROLE_RANK map (MEMBER<NET_CONTROL<OFFICER<ADMIN).
export function requireRole(min: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
    if (ROLE_RANK[req.user.role] < ROLE_RANK[min]) {
      throw new HttpError(403, 'FORBIDDEN', `Requires ${min} role`);
    }
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
  return req.user;
}
