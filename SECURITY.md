# Security Policy

Ham-Net-Assistant holds real member data — names, callsigns, e-mail addresses,
and a dated record of who was on the air — for volunteer-run college clubs.
Please treat findings accordingly.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security problem.**

Report privately, in this order of preference:

1. **GitHub private vulnerability reporting** — repository → **Security** tab →
   **Report a vulnerability**. This keeps the report, the fix, and the advisory
   in one place.
2. **E-mail** the maintainer: <klassenjames0@gmail.com>, subject line starting
   with `[HNA SECURITY]`.

A useful report contains:

- the version you tested — image tag (`ghcr.io/atvriders/ham-net-assistant:<sha>`)
  or commit SHA;
- how the instance is deployed (Docker Compose behind a proxy, bare `node`, …);
- the role the attacker needs (anonymous / MEMBER / NET_CONTROL / OFFICER /
  ADMIN) — privilege boundaries are the thing we care most about;
- reproduction steps, ideally a `curl` sequence;
- the impact you can actually demonstrate.

## What to expect

This is a small volunteer project, not a vendor with an on-call rotation. The
commitments are honest rather than ambitious:

| Stage | Target |
|---|---|
| Acknowledgement that a human read it | 5 business days |
| First assessment (accepted / needs info / not a vulnerability) | 10 business days |
| Fix or documented mitigation for an accepted high-severity issue | 30 days |

Fixes land on `master`, which publishes `ghcr.io/atvriders/ham-net-assistant:latest`;
operators upgrade by pulling. There is no backport branch — see
[README](README.md#upgrade--rollback). We will credit you in `CHANGELOG.md`
unless you ask us not to.

Please give us a reasonable window before public disclosure, and never test
against a club's live instance you don't administer.

## Supported versions

Only the current `master` / `:latest` image is supported. The project is
pre-1.0 and there are no maintained release branches; the SHA-tagged images CI
publishes exist for rollback, not for long-term support.

## In scope

- Authentication and session handling (JWT in the `hna_session` httpOnly
  cookie, argon2id password hashing, registration and the invite-code gate).
- **Authorization** — anything that lets a role act above its rank
  (MEMBER < NET_CONTROL < OFFICER < ADMIN). Concretely: a MEMBER reading
  `net.scriptMd` (server-side redaction), a NET_CONTROL reaching officer-only
  net/repeater/script CRUD or the `/api/stats/*` participation export, a
  non-admin reaching `/api/users`, `/api/admin/*`, `/api/discord/config`, or
  the log importer.
- Server-side request forgery in the three user-supplied-URL fetchers (theme
  logo import, Google-Docs log import, script import) — including redirect
  and DNS tricks that reach loopback, RFC1918, link-local, CGNAT, or cloud
  metadata endpoints.
- Injection and escaping: SQL/Prisma, CSV formula injection in the stats
  export, HTML/XSS through the net script and chat rendering paths (TipTap +
  DOMPurify), path traversal in the logo upload/serve routes.
- Data exposure: leaking e-mail addresses or the check-in history to a role
  that should not see them; secrets (Discord bot token, `JWT_SECRET`) turning
  up in API responses or logs.
- The container and its supply chain: the image running as root, world-writable
  paths under `/data`, or a build step that could be poisoned.

## Out of scope

- Anything that requires an already-compromised ADMIN account — ADMIN is
  intentionally omnipotent inside the app.
- Deployment configuration a club controls: no TLS terminator in front of the
  app, `JWT_SECRET` left at a placeholder, `REGISTRATION_CODE` unset (open
  registration is the documented default), an exposed `/data` volume, or a
  Discord bot token pasted into a public channel.
- Volumetric denial of service, and resource exhaustion that needs an
  authenticated account plus sustained abuse.
- Vulnerabilities in third-party services the app merely calls
  (callook.info, the Amateur Repeater Directory, HearHam, Discord) — report
  those to them.
- Missing hardening with no demonstrated impact (version banners, "no CAPTCHA",
  automated-scanner output pasted verbatim).

## Known design decisions, not vulnerabilities

Reporting these will get a polite "working as intended":

- **`N0CALL` is a shared placeholder callsign.** Duplicate `N0CALL` accounts are
  allowed on purpose so unlicensed members can register; every other callsign
  is unique.
- **Any authenticated member can read the club directory** (callsign + name)
  and can log a check-in for someone else's callsign during a live net. That
  is what net control does over the air — check-ins are a log of what was
  heard, not an authenticated identity claim.
- **Sessions cannot be revoked individually.** The cookie is a stateless JWT
  with a 12-hour lifetime. Demotions and deletions *do* take effect
  immediately — the role is read from the database on every request — but a
  cookie stolen from a user who still exists stays valid until it expires.
  Rotating `JWT_SECRET` invalidates every session at once and is the intended
  emergency lever.
- **Soft-deleted sessions and check-ins are not erased.** `deletedAt` hides
  them from the app; the admin trash UI simply stops listing rows older than
  30 days. The data stays in the SQLite file until an admin uses "Delete
  forever". "Delete" in the UI is not an erasure guarantee.
