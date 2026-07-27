import express, { type Express, type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';
import { loadUser } from './middleware/auth.js';
import { errorHandler, HttpError } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { repeatersRouter } from './routes/repeaters.js';
import { netsRouter } from './routes/nets.js';
import { sessionsRouter } from './routes/sessions.js';
import { checkinsRouter } from './routes/checkins.js';
import { statsRouter } from './routes/stats.js';
import { themesRouter } from './routes/themes.js';
import { logosRouter } from './routes/logos.js';
import { usersRouter } from './routes/users.js';
import { callsignLookupRouter } from './routes/callsignLookup.js';
import { topicsRouter } from './routes/topics.js';
import { messagesRouter } from './routes/messages.js';
import { scriptImportRouter } from './routes/scriptImport.js';
import { scriptsRouter } from './routes/scripts.js';
import { logImportRouter } from './routes/logImport.js';
import { adminRouter } from './routes/admin.js';
import { discordRouter } from './routes/discord.js';
import { presenceRouter } from './routes/presence.js';
import { mountStatic } from './static.js';

/** 429 body in the app's standard ApiError envelope (see `errorHandler`). */
function tooManyRequests(message: string) {
  // express-rate-limit sends this object with res.send(), which serializes it
  // as JSON. Without it the SPA's apiFetch sees a text/plain body and shows
  // the bare status line ("Too Many Requests") instead of a useful sentence.
  return { error: { code: 'RATE_LIMITED', message } };
}

const MINUTE = 60 * 1000;

/**
 * Per-IP caps, built per app instance.
 *
 * Instances (not module-level singletons) because each limiter owns a counter
 * store: sharing one across every app built in a process would let one test's
 * traffic exhaust another's budget. Production builds exactly one app.
 *
 * The sizing constraint is that a college club shares one campus NAT address,
 * so "per IP" often means "the whole club". A run-net console polls
 * /api/sessions/:id and the chat every 3s, the live-net indicator every 17s,
 * the presence roster every 30s and the heartbeat every 45s — about 47
 * requests/minute per open tab.
 */
function createLimiters() {
  return {
    // Deliberately generous. Worst realistic case is a whole club behind one
    // campus NAT on net night: ~8 run-net consoles (≈376/min) plus ~25
    // dashboard tabs (≈31/min each ≈ 775/min) ≈ 1150/min — which a 1200 cap
    // would clip at the club's busiest moment, and a 429 mid-net is a worse
    // outcome than any flood this cap would stop. The real credential and
    // outbound-fetch protection is in the specific limiters below; this one
    // exists only to bound a runaway client.
    api: rateLimit({
      windowMs: MINUTE,
      limit: 3000,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: tooManyRequests('Too many requests — slow down and try again shortly.'),
    }),
    // Login is the credential-guessing surface. Only *failed* attempts count
    // (`skipSuccessfulRequests`), because counting successes would lock out an
    // entire dorm behind one NAT address on a busy sign-in night while doing
    // nothing extra against an attacker, whose attempts are failures by
    // definition. 20 (not 10) leaves room for ordinary typos from a whole club
    // sharing one address; a dictionary attack is still throttled to 80
    // guesses/hour against a 12-char minimum password.
    login: rateLimit({
      windowMs: 15 * MINUTE,
      limit: 20,
      skipSuccessfulRequests: true,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: tooManyRequests('Too many failed sign-in attempts. Wait 15 minutes and try again.'),
    }),
    // Registration is capped per hour rather than per 15 minutes: club
    // onboarding happens in bursts (a whole meeting room signing up at once,
    // one NAT address), so the window has to be forgiving of a legitimate
    // crowd while still stopping scripted account creation.
    register: rateLimit({
      windowMs: 60 * MINUTE,
      limit: 30,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: tooManyRequests('Too many accounts created from this network. Try again later.'),
    }),
    // Callsign lookup and script import both make the server perform an
    // *outbound* request on the caller's behalf, so an unbounded caller can
    // use this app as a traffic amplifier against the FCC/callbook service.
    // Looser than login because net control legitimately looks up every
    // check-in during a net.
    outbound: rateLimit({
      windowMs: MINUTE,
      limit: 60,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: tooManyRequests('Too many lookups — wait a minute and try again.'),
    }),
  };
}

/**
 * Content-Security-Policy tuned to what apps/web actually builds:
 *  - Vite emits an external `<script type="module">` and no inline script, so
 *    script-src stays 'self' with no unsafe-inline escape hatch.
 *  - index.html loads the Google Fonts stylesheet (fonts.googleapis.com) which
 *    in turn pulls font files from fonts.gstatic.com; omitting either host
 *    silently drops the app to fallback system fonts.
 *  - React inline `style` props and the theme's injected <style> block need
 *    'unsafe-inline' in style-src (there is no nonce path through React's
 *    style attribute).
 *  - Logo uploads preview from blob:/data: URLs before they are saved.
 */
const helmetMiddleware: RequestHandler = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // Helmet's default set includes upgrade-insecure-requests. TLS is
      // terminated at the Cloudflare Tunnel, so it buys nothing in the
      // supported deployment — but it *breaks* the plain-HTTP LAN access
      // operators use while first setting the container up (every asset gets
      // rewritten to https:// against a host with no certificate).
      upgradeInsecureRequests: null,
    },
  },
  // COEP would require every cross-origin subresource to opt in with CORP
  // headers; Google's font CDN does not, so enabling it strips the app's
  // fonts. The app embeds no cross-origin isolated features that need it.
  crossOriginEmbedderPolicy: false,
});

export function buildApp(prisma: PrismaClient): Express {
  const app = express();
  // Behind the Cloudflare Tunnel every request arrives from the local tunnel
  // process, so without this `req.ip` is 127.0.0.1 for the whole internet:
  // rate-limit buckets would be shared by all users and one abusive client
  // would lock out the club. Exactly one proxy hop is trusted (the tunnel);
  // `true` would let a caller spoof X-Forwarded-For and dodge the limiter.
  app.set('trust proxy', 1);
  // Express 5 changed the default query parser from 'extended' to 'simple';
  // pin the v4 behavior explicitly so query-string semantics can't drift.
  app.set('query parser', 'extended');
  app.use(helmetMiddleware);
  // Limiters run before the body parser so a flood is shed before the server
  // spends memory parsing 1 MB payloads.
  const limiters = createLimiters();
  app.use('/api', limiters.api);
  app.use('/api/auth/login', limiters.login);
  app.use('/api/auth/register', limiters.register);
  app.use('/api/callsign-lookup', limiters.outbound);
  app.use('/api/script-import', limiters.outbound);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  // Scoped to /api: loadUser now costs a DB read, and static asset requests
  // have no use for req.user.
  app.use('/api', loadUser(prisma));

  app.use('/api/auth', authRouter(prisma));
  app.use('/api/callsign-lookup', callsignLookupRouter());
  app.use('/api/repeaters', repeatersRouter(prisma));
  app.use('/api/nets', netsRouter(prisma));
  const sessions = sessionsRouter(prisma);
  app.use('/api/nets/:netId/sessions', sessions.nested);
  app.use('/api/sessions', sessions.flat);
  const checkins = checkinsRouter(prisma);
  app.use('/api/sessions/:sessionId/checkins', checkins.nested);
  app.use('/api/checkins', checkins.flat);
  app.use('/api/stats', statsRouter(prisma));
  app.use('/api/themes', themesRouter(prisma));
  app.use('/api/themes', logosRouter());
  app.use('/api/users', usersRouter(prisma));
  app.use('/api/topics', topicsRouter(prisma));
  const messages = messagesRouter(prisma);
  app.use('/api/sessions/:sessionId/messages', messages.nested);
  app.use('/api/messages', messages.flat);
  app.use('/api/script-import', scriptImportRouter());
  app.use('/api/scripts', scriptsRouter(prisma));
  app.use('/api/log-import', logImportRouter(prisma));
  app.use('/api/admin', adminRouter(prisma));
  app.use('/api/discord', discordRouter(prisma));
  app.use('/api/presence', presenceRouter(prisma));

  // Unmatched /api requests must answer in the ApiError envelope. Without
  // this they reached Express's built-in "Cannot GET /api/typo" HTML page, so
  // the client's apiFetch — which only parses JSON — surfaced a bare status
  // line for what is really a routing bug. Mounted after every router and
  // before mountStatic, whose own catch-all deliberately excludes /api/, so
  // the two never overlap.
  // The message intentionally does not echo the requested path: attacker-
  // controlled text should never be reflected back, even in JSON.
  app.use('/api', (_req, _res, next) => {
    next(new HttpError(404, 'NOT_FOUND', 'Unknown API endpoint'));
  });

  mountStatic(app);
  app.use(errorHandler);
  return app;
}
