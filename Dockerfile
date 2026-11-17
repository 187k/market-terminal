# syntax=docker/dockerfile:1
#
# One build, three images:
#   runtime  - collector, engine and api (same image, different command)
#   migrate  - applies Prisma migrations, then exits
#   web      - nginx serving the dashboard and proxying /api and /ws to the api service

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV CI=true \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# ---- install all dependencies (cached until a package.json or the lockfile changes)
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/bus/package.json packages/bus/
COPY packages/analytics/package.json packages/analytics/
COPY packages/connectors/package.json packages/connectors/
COPY packages/db/package.json packages/db/
COPY apps/collector/package.json apps/collector/
COPY apps/engine/package.json apps/engine/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

# ---- compile everything (includes `prisma generate`)
FROM deps AS build
COPY . .
RUN npm run build

# ---- migrations need the Prisma CLI, a dev dependency, so they run from the build stage
FROM build AS migrate
CMD ["npm", "run", "db:deploy"]

# ---- production image: production dependencies + compiled output only
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/package.json /app/package-lock.json ./
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/bus/dist packages/bus/dist
COPY --from=build /app/packages/analytics/dist packages/analytics/dist
COPY --from=build /app/packages/connectors/dist packages/connectors/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/collector/dist apps/collector/dist
COPY --from=build /app/apps/engine/dist apps/engine/dist
COPY --from=build /app/apps/api/dist apps/api/dist
USER node
CMD ["node", "apps/api/dist/main.js"]

# ---- dashboard
FROM nginx:1.29-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
