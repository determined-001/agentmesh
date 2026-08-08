# AgentMesh services image (seller-agent + watcher; pick with SERVICE).
# Build:  docker build -t agentmesh .
# Run:    docker run -e SERVICE=seller-agent ... agentmesh
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# ---- install + build workspace ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json biome.json ./
COPY packages ./packages
COPY apps/seller-agent ./apps/seller-agent
COPY apps/watcher ./apps/watcher
RUN pnpm install --frozen-lockfile --filter "@agentmesh/seller-agent..." --filter "@agentmesh/watcher..."
RUN pnpm --filter @agentmesh/shared build && pnpm --filter @agentmesh/sdk build

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# SQLite data lives here; mount a volume over it. Owned by `node` so the
# service can write it without running as root.
RUN mkdir -p /app/apps/seller-agent/data /app/apps/watcher/data \
    && chown -R node:node /app
ARG SERVICE=seller-agent
ENV SERVICE=${SERVICE}
# These are long-running network services parsing untrusted input; root is not
# a privilege they need.
USER node
CMD ["sh", "-c", "pnpm --filter @agentmesh/${SERVICE} start"]
