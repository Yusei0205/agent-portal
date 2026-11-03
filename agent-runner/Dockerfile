# agent-runner — Amazon Bedrock AgentCore Runtime container
# Platform: linux/arm64 (required by AgentCore Runtime)
# Build context: repo root (so we can COPY server/agent/guard.ts and env-scrub.ts)
#
# Usage:
#   docker buildx build --platform linux/arm64 --load \
#     -f agent-runner/Dockerfile -t agent-runner:local .

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /build

# Copy agent-runner dependency manifests first (cache layer)
COPY agent-runner/package.json agent-runner/package-lock.json* ./

# Install ALL dependencies (including devDeps for esbuild + tsc)
RUN npm ci

# Copy agent-runner source
COPY agent-runner/src/ ./src/
COPY agent-runner/tsconfig.json ./
COPY agent-runner/build.mjs ./

# Copy portal's pure modules into shared/ — same source as the portal (not a copy of content,
# a copy at build time so the compiled bundle includes the live versions).
# These are imported as ../shared/guard.ts and ../shared/env-scrub.ts in run.ts.
COPY server/agent/guard.ts ./shared/guard.ts
COPY server/agent/env-scrub.ts ./shared/env-scrub.ts
COPY server/agent/runner-files.ts ./shared/runner-files.ts
COPY server/agent/runner-repos.ts ./shared/runner-repos.ts

# Compile + bundle → dist/index.mjs
# @anthropic-ai/claude-agent-sdk stays external (installed in runtime stage)
RUN node build.mjs


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Install git (for shallow clones in repo-based runs)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only production dependency manifests
COPY agent-runner/package.json agent-runner/package-lock.json* ./

# Install production deps only (includes @anthropic-ai/claude-agent-sdk)
RUN npm ci --omit=dev

# Copy compiled bundle from builder
COPY --from=builder /build/dist/ ./dist/

# Create a non-root user with a fixed UID
# Create a non-root user (reuse the node user that already exists in node:22-slim at UID 1000)
# /tmp is already world-writable in the base image.
USER node

EXPOSE 8080

# Structured JSON log line on start: { "event": "server_ready", "port": 8080 ... }
CMD ["node", "dist/index.mjs"]
