# syntax=docker/dockerfile:1.7

# --- base: debian slim instead of alpine ---
FROM node:20-slim AS base
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
RUN npm install

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
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# libssl3 is in node:20-slim already; add ca-certs, wget for healthcheck, gosu for step-down
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates wget gosu \
    && rm -rf /var/lib/apt/lists/*

# Manifests — only api + shared, NOT web (dist is static)
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/prisma apps/api/prisma

# Install api prod deps + generate prisma client in a single layer
RUN npm install --omit=dev --workspace @hna/api --include-workspace-root=false \
    && npx -w @hna/api prisma generate \
    && npm cache clean --force

# Built artifacts
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/themes themes

# Non-root user created, but we START as root and let the entrypoint drop to hna.
RUN groupadd -r hna && useradd -r -g hna hna \
    && mkdir -p /data /data/logos \
    && chown -R hna:hna /app /data

# Entrypoint: fix /data ownership (for pre-existing volumes) then step down
COPY docker/entrypoint.sh /usr/local/bin/hna-entrypoint.sh
RUN chmod +x /usr/local/bin/hna-entrypoint.sh

ENV STATIC_DIR=/app/apps/web/dist
ENV DATABASE_URL=file:/data/ham.db
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/themes >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/hna-entrypoint.sh"]
CMD ["sh","-c","npx -w @hna/api prisma migrate deploy && exec node apps/api/dist/index.js"]
