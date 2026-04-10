import type { Request, RequestHandler } from 'express';
import type { Role } from '@hna/shared';
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

const ORDER: Record<Role, number> = { MEMBER: 0, OFFICER: 1, ADMIN: 2 };

export function requireRole(min: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
    if (ORDER[req.user.role] < ORDER[min]) {
      throw new HttpError(403, 'FORBIDDEN', `Requires ${min} role`);
    }
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
  return req.user;
}
