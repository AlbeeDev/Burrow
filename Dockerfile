# Burrow: gateway + web app in one image.
# Stage 1 builds the Vite app; stage 2 runs the Node gateway (which serves the built
# app and the WebSocket on one port). Debian (glibc) so the bundled Claude Code binary
# and node-pty prebuilds work; tmux is installed for terminal-session persistence.

# Stage 1: build the web app
FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY app/package*.json app/
RUN cd app && npm install
COPY app app/
# Vite outDir is ../server/web, so the build lands in /build/server/web.
RUN cd app && npm run build

# Stage 2: gateway runtime
FROM node:22-bookworm-slim
# util-linux provides nsenter: used (with BURROW_HOST_EXEC=1) to run tmux/claude in the
# host's namespaces for full tool parity. tmux/git/jq remain as the in-container fallback.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux git ca-certificates jq util-linux \
  && rm -rf /var/lib/apt/lists/*
# The Claude Code CLI (for Terminal-mode `claude -c`). The SDK bundles its own binary
# for programmatic use, but a terminal needs `claude` on PATH.
RUN npm install -g @anthropic-ai/claude-code@2.1.177
WORKDIR /app
COPY server/package*.json ./
RUN npm install
COPY server/ ./
COPY --from=web /build/server/web ./web
EXPOSE 8317
CMD ["npm", "start"]
