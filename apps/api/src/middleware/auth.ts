import type { Request, RequestHandler } from 'express';
import { ROLE_RANK, type Role } from '@hna/shared';
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

export const loadUser: RequestHandler = (req, _res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      const claims = verifyToken(token);
      req.user = { id: claims.sub, role: claims.role };
    } catch {
      /* invalid token → anonymous */
    }
  }
  next();
};

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
