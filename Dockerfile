FROM oven/bun:1.1 AS base
WORKDIR /app

FROM base AS install
COPY package.json ./
RUN bun install

FROM install AS build
COPY src ./src
COPY bun.lock ./
COPY tsconfig.json ./
COPY openapi.json ./
RUN bun build src/index.ts --outdir=dist --target=bun --external '@opentelemetry/*'

FROM base AS production
# Runtime resource limits should be enforced via orchestrator (e.g. Kubernetes limits/requests
# or Docker --memory / --cpus). Recommended minimum: 512 MiB memory, 0.5 vCPU.
ENV NODE_ENV=production
ENV TZ=UTC

COPY --from=install /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY openapi.json ./

# Pricing config for runtime hot-reload (resolved via import.meta.url → ../config/pricing.json from dist/index.js)
COPY src/config/pricing.json ./config/pricing.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["bun", "run", "dist/index.js"]
