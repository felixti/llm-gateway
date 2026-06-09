FROM node:24-alpine AS build
WORKDIR /app
COPY tools/dev-idp/package.json tools/dev-idp/yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile
COPY tools/dev-idp/ ./
RUN yarn build

FROM node:24-alpine AS production
WORKDIR /app
RUN apk add --no-cache wget
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "dist/server.js"]
