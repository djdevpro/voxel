# syntax=docker/dockerfile:1

# ---------- build : front (apps/web) + passerelle IMAP (apps/server), SPEC-v3 §10 ----------
FROM node:24-alpine AS build
WORKDIR /app

# Manifestes d'abord pour profiter du cache de couches sur npm ci.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/jmap/package.json packages/jmap/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ---------- exécution ----------
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    VOXEL_DATA_DIR=/data \
    VOXEL_WEB_DIST=/app/apps/web/dist
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/jmap packages/jmap

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/dist/index.js"]
