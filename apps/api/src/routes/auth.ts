import { Router } from 'express';
import type { z } from 'zod';
import { PrismaClient, Prisma } from '@prisma/client';
import { RegisterInput, LoginInput, PublicUser, type Role } from '@hna/shared';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken, COOKIE_NAME, COOKIE_OPTS } from '../lib/jwt.js';
import { env } from '../env.js';
import { HttpError } from '../middleware/error.js';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async.js';
import { getSetting } from '../lib/settings.js';
import { DEFAULT_THEME_SETTING_KEY } from './themes.js';

/**
 * One message for "email taken" AND "callsign taken".
 *
 * Login already refuses to say whether an account exists; registration used to
 * answer "Email already in use", which turned the public sign-up form into a
 * membership oracle — anyone could test a list of addresses (or callsigns,
 * which map to real names and home addresses in the FCC database) against the
 * club roster. The wording still tells a genuine user what to do next.
 */
const DUPLICATE_REGISTRATION_MESSAGE =
  'That email or callsign is already registered. Try signing in, or contact a club officer for help.';

/**
 * Case-insensitive lookup of a user id by email.
 *
 * SQLite's UNIQUE index on User.email is BINARY and email input is normalized
 * to lowercase, so accounts created before normalization can be stored as
 * "Bob@X.com" — invisible to `findUnique({ email: 'bob@x.com' })`. Those
 * members would silently be unable to sign in (and could re-register as a
 * second account). Prisma has no case-insensitive filter on SQLite, hence the
 * raw LOWER() comparison. `email` is passed as a bound parameter, not
 * interpolated.
 *
 * SQLite's LOWER() is ASCII-only, so a legacy row with a non-ASCII uppercase
 * character in the local part would not be matched — accepted, since the
 * shared Email schema only admits addresses that are ASCII in practice.
 */
async function findUserIdByEmailInsensitive(
  prisma: PrismaClient,
  email: string,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User" WHERE LOWER(email) = ${email.toLowerCase()} LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export function authRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/config', (_req, res) => {
    res.json({ inviteCodeRequired: Boolean(env.REGISTRATION_CODE) });
  });

  router.post(
    '/register',
    validateBody(RegisterInput),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof RegisterInput>;
      if (env.REGISTRATION_CODE && input.inviteCode !== env.REGISTRATION_CODE) {
        throw new HttpError(403, 'FORBIDDEN', 'Invalid invite code');
      }
      const passwordHash = await hashPassword(input.password);
      let finalCallsign = input.callsign;
      if (finalCallsign === 'N0CALL' || /^N0CALL\d+$/.test(finalCallsign)) {
        finalCallsign = 'N0CALL';
      } else {
        // Reject duplicate non-N0CALL callsigns up front. (N0CALL is the
        // shared placeholder for unlicensed members and is allowed to repeat.)
        // `RegisterInput.callsign` is already trimmed + uppercased by the
        // shared `Callsign` zod schema, so this match is canonical.
        const existing = await prisma.user.findFirst({
          where: { callsign: finalCallsign },
        });
        if (existing) {
          throw new HttpError(409, 'CONFLICT', DUPLICATE_REGISTRATION_MESSAGE);
        }
      }
      // Catch a legacy mixed-case row that the (binary) unique index would let
      // through as a second account for the same person.
      if (await findUserIdByEmailInsensitive(prisma, input.email)) {
        throw new HttpError(409, 'CONFLICT', DUPLICATE_REGISTRATION_MESSAGE);
      }
      // First-admin determination + create are wrapped in a transaction so two
      // concurrent first registrations can't both observe count=0 and both
      // become ADMIN.
      try {
        const user = await prisma.$transaction(async (tx) => {
          const count = await tx.user.count();
          const role = count === 0 ? 'ADMIN' : 'MEMBER';
          let initialCollegeSlug: string | null = null;
          if (role === 'MEMBER') {
            initialCollegeSlug = await getSetting(prisma, DEFAULT_THEME_SETTING_KEY);
          }
          return tx.user.create({
            data: {
              email: input.email,
              name: input.name,
              callsign: finalCallsign,
              passwordHash,
              role,
              collegeSlug: initialCollegeSlug,
            },
          });
        });
        const token = signToken({
          sub: user.id,
          role: user.role as Role,
        });
        res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
        res.status(201).json(PublicUser.parse(toPublic(user)));
      } catch (e) {
        // Still needed despite the pre-check above: two simultaneous sign-ups
        // with the same email both pass the check and only one wins the index.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new HttpError(409, 'CONFLICT', DUPLICATE_REGISTRATION_MESSAGE);
        }
        throw e;
      }
    }),
  );

  router.post(
    '/login',
    validateBody(LoginInput),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof LoginInput>;
      let user = await prisma.user.findUnique({ where: { email: input.email } });
      if (!user) {
        // Legacy account stored with mixed-case email — see
        // findUserIdByEmailInsensitive.
        const legacyId = await findUserIdByEmailInsensitive(prisma, input.email);
        if (legacyId) user = await prisma.user.findUnique({ where: { id: legacyId } });
      }
      if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid credentials');
      }
      const token = signToken({
        sub: user.id,
        role: user.role as Role,
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
    role: u.role as Role,
    collegeSlug: u.collegeSlug,
  };
}
