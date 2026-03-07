# syntax=docker/dockerfile:1

# ── Builder stage: install deps, compile TS, include tests ──────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

# ── Runtime stage: minimal, production deps only ─────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build ./build

# Create workspace dirs for file-based tools (tickets, patches, plans, etc.)
RUN mkdir -p /data/workspace/tickets/tickets \
             /data/workspace/tickets/patches \
             /data/workspace/plans

ENV MINIMART_FILE_WORKSPACE=/data/workspace

EXPOSE 6974 6975 6976

# Default: start the main MiniMart surface
CMD ["node", "build/index.js"]
