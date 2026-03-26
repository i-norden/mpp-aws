# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim@sha256:1e85773c98c31d4fe5b545e4cb17379e617b348832fb3738b22a08f68dec30f3 AS build

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for the build)
RUN npm ci

# Copy source code and build config
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/

# Build the TypeScript project
RUN npx tsup

# ---------------------------------------------------------------------------
# Stage 2: Production
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs20-debian12:nonroot@sha256:2cd820156cf039c8b54ae2d2a97e424b6729070714de8707a6b79f20d56f6a9a

WORKDIR /app

# Copy compiled output and runtime assets only. The final image intentionally
# excludes npm and node_modules to minimize the attack surface and remove
# scanner noise from bundled package-manager dependencies.
COPY --from=build --chown=nonroot:nonroot /app/dist/ dist/

# Copy database migrations (needed at runtime for auto-migration)
COPY --chown=nonroot:nonroot db/migrations/ db/migrations/

# Expose default ports (main API + health)
EXPOSE 8080 8081

# Health check against the health endpoint without requiring a shell/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8081/health/live').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["dist/index.js"]
