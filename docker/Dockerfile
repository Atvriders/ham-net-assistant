# syntax=docker/dockerfile:1.7

# --- base: debian slim instead of alpine ---
# bookworm pinned explicitly: Prisma 6's engine binaryTarget is
# debian-openssl-3.0.x, and node's un-suffixed `-slim` default can move to a
# newer Debian (node:26-slim is already trixie/openssl-3.5).
FROM node:24-bookworm-slim AS base
WORKDIR /app
# build tools for native deps (argon2) — debian package names
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- deps: workspace manifests only for cache efficiency ---
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# `npm ci`, matching CI: `install` silently rewrites the lockfile when a
# manifest has drifted, which would let the SHIPPED IMAGE be built from a
# dependency tree no developer and no CI run ever resolved to. `ci` fails
# loudly instead. Safe here because all four manifests plus the lockfile are
# present in this stage (verified: `npm ci` resolves against manifests alone,
# no sources needed). The runtime stage below deliberately keeps `npm install`
# — apps/web/package.json is absent there by design, so `ci` cannot run.
RUN npm ci

# --- build: full sources + builds ---
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
COPY themes themes
RUN npm -w @hna/shared run build
RUN npx -w @hna/api prisma generate
RUN npm -w @hna/api run build
RUN npm -w @hna/web run build

# --- runtime: slim image with only what api needs ---
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# libssl3 is in the bookworm-slim base already; add ca-certs + gosu for step-down.
# wget intentionally omitted — healthcheck uses node's built-in http to avoid
# pulling an extra package into the final layer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

# Non-root user created FIRST (before any large COPY layers) so the later
# chown -R doesn't have to rewrite every file from previous layers into this
# layer's blob — that recursive rewrite was the layer-bloat culprit pushing
# the image over the 100 MB Cloudflare proxy body cap on `git.waterburp.com`.
# /data/backups holds the entrypoint's pre-migration snapshots. It is created
# here (and again in the entrypoint, for volumes that predate this image) so it
# always lives inside the mounted volume rather than the container layer.
RUN groupadd -r hna && useradd -r -g hna hna \
    && mkdir -p /data /data/logos /data/backups \
    && chown hna:hna /data /data/logos /data/backups

# Manifests — only api + shared, NOT web (dist is static)
COPY --from=build --chown=hna:hna /app/package.json /app/package-lock.json ./
COPY --from=build --chown=hna:hna /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=hna:hna /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=hna:hna /app/apps/api/package.json apps/api/
COPY --from=build --chown=hna:hna /app/apps/api/prisma apps/api/prisma

# Install api prod deps in its own layer. Scope the chown to node_modules
# only (NOT a recursive `chown /app`) so this layer's blob is just the new
# install — not a rewrite of every file from previous layers.
RUN npm install --omit=dev --workspace @hna/api --include-workspace-root=false \
    && npm cache clean --force \
    && chown -R hna:hna /app/node_modules

# Generate prisma client in a SEPARATE layer so the ~50 MB engine binaries
# (Prisma client + engines from npm install) and the ~20 MB generated client
# (.prisma/client) land in distinct blobs rather than concatenated — keeps
# each blob comfortably under the Cloudflare 100 MB body cap on the
# git.waterburp.com registry push.
RUN npx -w @hna/api prisma generate \
    && chown -R hna:hna /app/node_modules/.prisma 2>/dev/null || true

# Built artifacts (small) in a tail layer. This is also what puts the operator
# CLIs in the image: apps/api/dist/cli/backup.js (called by the entrypoint) and
# apps/api/dist/cli/admin.js (account recovery), e.g.
#   docker compose exec -u hna hna node apps/api/dist/cli/admin.js list-admins
COPY --from=build --chown=hna:hna /app/apps/api/dist apps/api/dist
COPY --from=build --chown=hna:hna /app/apps/web/dist apps/web/dist
COPY --from=build --chown=hna:hna /app/themes themes

# Entrypoint: fix /data ownership (for pre-existing volumes) then step down
COPY docker/entrypoint.sh /usr/local/bin/hna-entrypoint.sh
RUN chmod +x /usr/local/bin/hna-entrypoint.sh

ENV STATIC_DIR=/app/apps/web/dist
ENV DATABASE_URL=file:/data/ham.db
EXPOSE 3000

# Use node's built-in http to avoid bundling wget into the runtime layer.
# /api/themes/default (not /api/themes): the plain theme list is read from
# theme.json files on disk and answers 200 even when the database is corrupt,
# locked or unmigrated — an unusable container reporting healthy. This route
# reads the Setting table, so a broken database becomes a 500. Keep this in
# sync with the healthcheck in docker-compose.yml, which overrides it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/themes/default',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" || exit 1

ENTRYPOINT ["/usr/local/bin/hna-entrypoint.sh"]
CMD ["sh","-c","npx -w @hna/api prisma migrate deploy && exec node apps/api/dist/index.js"]
