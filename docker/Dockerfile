# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install

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

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Root + workspace manifests — NOTE we DO NOT copy apps/web/package.json
# so the web workspace is absent at install time and its deps are skipped.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/

# Prisma schema is needed before generate; copy it before the install layer
# so that install + generate can be fused into a single layer (avoids layer
# duplication of @prisma/client engine binaries).
COPY --from=build /app/apps/api/prisma apps/api/prisma

# Install only the API's production deps (workspace resolution picks up @hna/shared)
# and generate the prisma client in the same layer.
RUN npm install --omit=dev --workspace @hna/api --include-workspace-root=false \
    && npx -w @hna/api prisma generate \
    && npm cache clean --force

# Copy built artifacts
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/themes themes
ENV STATIC_DIR=/app/apps/web/dist
ENV DATABASE_URL=file:/data/ham.db
EXPOSE 3000
CMD ["sh", "-c", "npx -w @hna/api prisma migrate deploy && node apps/api/dist/index.js"]
