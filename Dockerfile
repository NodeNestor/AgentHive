# AgentHive router image.
# The router itself is stateless-ish — it talks to Docker on the host
# and spawns agentcore:ubuntu containers as sessions. SQLite state
# lives on a bind-mounted volume (see docker-compose.yml).

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Build deps for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Runtime ─────────────────────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app

# Docker CLI (for debugging / admin); dockerode uses the socket.
RUN apt-get update && apt-get install -y --no-install-recommends \
      docker.io ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY examples ./examples
COPY hooks-lib ./hooks-lib

ENV NODE_ENV=production
EXPOSE 7700

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
