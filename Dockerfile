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
ENV NODE_ENV=production
ENV TZ=UTC

COPY --from=install /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY openapi.json ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "run", "dist/index.js"]
