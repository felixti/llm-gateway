FROM oven/bun:1.0 AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json ./
RUN bun install --frozen-lockfile

# Build stage
FROM install AS build
COPY . .
RUN bun build src/index.ts --outdir=dist --target=bun

# Production stage
FROM base AS production
ENV NODE_ENV=production
ENV TZ=UTC

# Copy dependencies and built artifacts
COPY --from=install /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["bun", "run", "src/index.ts"]
