# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build

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
FROM node:20-alpine

# Security: run as non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy package manifests and install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist/ dist/

# Copy database migrations (needed at runtime for auto-migration)
COPY db/migrations/ db/migrations/

# Switch to non-root user
USER app

# Expose default ports (main API + health)
EXPOSE 8080 8081

# Health check against the health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8081/health/live || exit 1

CMD ["node", "dist/index.js"]
