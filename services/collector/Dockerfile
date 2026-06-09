FROM node:24-alpine AS build
WORKDIR /app
COPY services/collector/package.json services/collector/yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile
COPY packages/shared /packages/shared
COPY services/collector/ ./
RUN yarn build

FROM node:24-alpine AS production
WORKDIR /app
RUN apk add --no-cache wget
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4100/health || exit 1
CMD ["node", "dist/server.js"]
