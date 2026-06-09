FROM node:24-alpine AS build
WORKDIR /app
COPY services/gateway/package.json services/gateway/yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile
COPY packages/shared /packages/shared
COPY services/gateway/ ./
RUN yarn build

FROM node:24-alpine AS production
WORKDIR /app
RUN apk add --no-cache wget
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
