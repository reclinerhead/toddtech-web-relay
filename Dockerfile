# syntax=docker/dockerfile:1

# Multi-stage: build with the full dependency set, ship only production
# dependencies and compiled output, run as the image's unprivileged `node`
# user. Alpine rather than distroless so the compose healthcheck has wget.

FROM node:24-alpine AS base
RUN npm install -g pnpm@11
WORKDIR /app
COPY package.json pnpm-lock.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine
ENV NODE_ENV=production \
    RELAY_BIND=0.0.0.0 \
    RELAY_PORT=8787
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
