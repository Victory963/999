# 999 agent-computer — containerized for real isolation.
# The container IS the sandbox boundary (see docs/SECURITY.md); pair it with an
# egress firewall in production.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app
RUN corepack enable

# Dependencies (cached layer)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Chromium + its OS dependencies, into a shared path the app user can read.
RUN pnpm exec playwright install --with-deps chromium

# App source
COPY tsconfig.json ./
COPY src ./src

# Run as a non-root user; workspace is the only app-writable dir.
RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/workspace \
    && chown -R app:app /app /pnpm /ms-playwright
USER app

ENV HOST=0.0.0.0 \
    PORT=8080 \
    WORKSPACE_DIR=/app/workspace
EXPOSE 8080
CMD ["pnpm", "start"]
