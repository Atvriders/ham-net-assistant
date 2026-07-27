---
name: Bug report
about: Something in the app behaves incorrectly
title: '[bug] '
labels: bug
---

<!--
STOP if this is a security vulnerability — do not file it here.
Follow SECURITY.md instead (private report).
-->

## What happened

<!-- One or two sentences. What you saw. -->

## What you expected

## Steps to reproduce

1.
2.
3.

## Where

- **Version:** image tag (`ghcr.io/atvriders/ham-net-assistant:<tag-or-sha>`) or commit SHA:
- **How it runs:** Docker Compose / local `npm run dev:api` + `dev:web` / other:
- **Role of the account involved:** MEMBER / NET_CONTROL / OFFICER / ADMIN / logged out:
- **Browser + OS** (for UI bugs):

## Net context, if the bug involves a net

<!-- Timing bugs are usually timezone bugs. Fill this in for anything touching
     sessions, reminders, auto-open or auto-start. -->

- Net kind: weekly / impromptu
- Net timezone and scheduled start (`startLocal`):
- Session state when it happened: PREP (opened, not started) / LIVE / ended
- Was the session auto-opened or auto-started, or did a human press the button?

## Evidence

<!-- Screenshots, and logs from `docker compose logs --tail=200 hna`.
     Redact JWT_SECRET, the Discord bot token, and member e-mail addresses. -->

```
paste logs here
```

## Impact

<!-- Did this break a live net? Is data wrong or missing? Is there a workaround? -->
