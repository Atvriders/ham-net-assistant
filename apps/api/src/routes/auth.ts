import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { RegisterInput, LoginInput, PublicUser } from '@hna/shared';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken, COOKIE_NAME, COOKIE_OPTS } from '../lib/jwt.js';
import { env } from '../env.js';
import { HttpError } from '../middleware/error.js';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';
import { getSetting } from '../lib/settings.js';
import { DEFAULT_THEME_SETTING_KEY } from './themes.js';

export function authRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/config', (_req, res) => {
    res.json({ inviteCodeRequired: Boolean(env.REGISTRATION_CODE) });
  });

  router.post(
    '/register',
    validateBody(RegisterInput),
    asyncHandler(async (req, res) => {
      const input = req.body as typeof RegisterInput._type;
      if (env.REGISTRATION_CODE && input.inviteCode !== env.REGISTRATION_CODE) {
        throw new HttpError(403, 'FORBIDDEN', 'Invalid invite code');
      }
      const count = await prisma.user.count();
      const role = count === 0 ? 'ADMIN' : 'MEMBER';
      const passwordHash = await hashPassword(input.password);
      let finalCallsign = input.callsign;
      if (finalCallsign === 'N0CALL' || /^N0CALL\d+$/.test(finalCallsign)) {
        finalCallsign = 'N0CALL';
      }
      let initialCollegeSlug: string | null = null;
      if (role === 'MEMBER') {
        initialCollegeSlug = await getSetting(prisma, DEFAULT_THEME_SETTING_KEY);
      }
      try {
        const user = await prisma.user.create({
          data: {
            email: input.email,
            name: input.name,
            callsign: finalCallsign,
            passwordHash,
            role,
            collegeSlug: initialCollegeSlug,
          },
        });
        const token = signToken({
          sub: user.id,
          role: user.role as 'MEMBER' | 'OFFICER' | 'ADMIN',
        });
        res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
        res.status(201).json(PublicUser.parse(toPublic(user)));
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new HttpError(409, 'CONFLICT', 'Email or callsign already in use');
        }
        throw e;
      }
    }),
  );

  router.post(
    '/login',
    validateBody(LoginInput),
    asyncHandler(async (req, res) => {
      const input = req.body as typeof LoginInput._type;
      const user = await prisma.user.findUnique({ where: { email: input.email } });
      if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid credentials');
      }
      const token = signToken({
        sub: user.id,
        role: user.role as 'MEMBER' | 'OFFICER' | 'ADMIN',
      });
      res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
      res.json(PublicUser.parse(toPublic(user)));
    }),
  );

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: 0 });
    res.status(204).end();
  });

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'User no longer exists');
      res.json(PublicUser.parse(toPublic(user)));
    }),
  );

  return router;
}

function toPublic(u: {
  id: string;
  email: string;
  name: string;
  callsign: string;
  role: string;
  collegeSlug: string | null;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    callsign: u.callsign,
    role: u.role as 'MEMBER' | 'OFFICER' | 'ADMIN',
    collegeSlug: u.collegeSlug,
  };
}
