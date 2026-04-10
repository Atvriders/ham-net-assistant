# Ham-Net-Assistant

Web app for college amateur-radio clubs to manage repeaters, schedule
weekly nets, run live check-ins, and produce FCC-friendly sign-in logs
and participation statistics for funding requests.

Ships with pickable college themes (K-State, MIT, Georgia Tech,
Virginia Tech, Illinois, plus a neutral default).

## Dev

    npm install
    npm run dev:api    # terminal 1
    npm run dev:web    # terminal 2

Frontend at http://localhost:5173 (proxies /api to :3000).

## Test

    npm test

## Run with Docker Compose

Uses the prebuilt image from GHCR — no local build required:

    docker compose up -d

To build from source instead (requires the repo checkout):

    docker build -f docker/Dockerfile -t hna:local .
    docker run -p 3030:3000 -v hna-data:/data \
      -e JWT_SECRET=change-me-change-me-change-me hna:local

Then open http://localhost:3030. First registered user becomes ADMIN.

## Environment

- `JWT_SECRET` (required, >= 16 chars)
- `REGISTRATION_CODE` (optional invite gate)
- `DATABASE_URL` (default `file:/data/ham.db` in docker)
- `PORT` (default 3000)

## Themes

Drop your own `themes/<slug>/logo.svg` to brand the app for your club.
See `themes/README.md` for the trademark note.

## Docs

- Design: `docs/superpowers/specs/2026-04-10-ham-net-assistant-design.md`
- Plan: `docs/superpowers/plans/2026-04-10-ham-net-assistant.md`
