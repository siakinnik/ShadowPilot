# ------------------------------
# ShadowPilot - Docker image
# ------------------------------

# Build stage: compiles better-sqlite3 if no prebuilt binary fits the platform
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# telegraf-hardened is installed from a GitHub commit (Bot API 10.3 test build);
# npm records it as git+ssh, but the image has no SSH key -> clone over HTTPS
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global --add url."https://github.com/".insteadOf "git@github.com:"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage: small image without build tools
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DB_PATH=/app/database/shadow_pilot.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY config ./config
COPY src ./src
# Database lives in a volume; the unprivileged "node" user must own it
RUN mkdir -p /app/database && chown -R node:node /app/database
USER node
VOLUME ["/app/database"]
CMD ["node", "src/index.js"]
