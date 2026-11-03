# kiro-runner — Amazon Bedrock AgentCore Runtime container
# Platform: linux/arm64 (required by AgentCore Runtime)
# Build context: repo root (same pattern as agent-runner)
#
# Usage:
#   docker buildx build --platform linux/arm64 --load \
#     -f kiro-runner/Dockerfile -t kiro-runner:local .
#
# kiro-cli architecture note:
#   On arm64 Debian Bookworm (glibc 2.36) the installer falls back to the
#   statically-linked musl build (kirocli-aarch64-linux-musl.zip) because
#   the gnu build requires glibc >= 2.39.  The musl build is fully supported
#   and works identically.

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /build

# Copy kiro-runner dependency manifests first (cache layer)
COPY kiro-runner/package.json kiro-runner/package-lock.json* ./

# Install ALL dependencies (devDeps for esbuild + tsc)
RUN npm install

# Copy source files
COPY kiro-runner/src/ ./src/
COPY kiro-runner/tsconfig.json ./
COPY kiro-runner/build.mjs ./
COPY server/agent/runner-files.ts ./shared/runner-files.ts
COPY server/agent/runner-repos.ts ./shared/runner-repos.ts
COPY server/agent/runner-snapshot.ts ./shared/runner-snapshot.ts
COPY agent-runner/src/browser-tools.ts ./shared/browser-tools.ts

# Compile + bundle → dist/index.mjs (no external runtime deps; node:* built-ins only)
RUN node build.mjs


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# System packages needed to install kiro-cli
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl \
      unzip \
      ca-certificates \
      bash \
      git \
    && rm -rf /var/lib/apt/lists/*

# Install kiro-cli — the installer puts binaries in /root/.local/bin by default.
# After install: copy kiro-cli and kiro-cli-chat to /usr/local/bin so they are
# accessible to the non-root node user at runtime.
# The installer auto-detects aarch64 and downloads kirocli-aarch64-linux-musl.zip
# (musl static build, required on Debian Bookworm glibc 2.36 < 2.39 threshold).
RUN curl -LsSf https://cli.kiro.dev/install > /tmp/kiro-install.sh && \
    bash /tmp/kiro-install.sh --force --no-modify-path && \
    rm /tmp/kiro-install.sh && \
    # Copy all kiro-cli binaries to a world-accessible location
    find /root/.local/bin -maxdepth 1 -name 'kiro-cli*' -exec cp {} /usr/local/bin/ \; && \
    chmod 755 /usr/local/bin/kiro-cli* && \
    kiro-cli --version

WORKDIR /app

# playwright-core is the only runtime dependency (the browser tools connect to AgentCore Browser over CDP; no browser is downloaded)
COPY kiro-runner/package.json kiro-runner/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Copy compiled bundles from builder
COPY --from=builder /build/dist/ ./dist/

# Run as non-root user (UID 1000, from base image)
USER node

EXPOSE 8080

# Structured JSON log line on start: { "event": "server_ready", "port": 8080 ... }
CMD ["node", "dist/index.mjs"]
