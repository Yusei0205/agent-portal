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
# Base image; CodeBuild passes AWS's public ECR mirror (public.ecr.aws/docker/library/node:22-slim).
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS builder

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
COPY server/agent/runner-inspect.ts ./shared/runner-inspect.ts
COPY server/agent/runner-snapshot.ts ./shared/runner-snapshot.ts
COPY server/agent/runner-mcp.ts ./shared/runner-mcp.ts
COPY server/agent/runner-checks.ts ./shared/runner-checks.ts
COPY server/agent/runner-finalize.ts ./shared/runner-finalize.ts
COPY agent-runner/src/browser-tools.ts ./shared/browser-tools.ts
# Portal modules the runner shares with the portal (guard, approvals, env scrub), same layout as server/.
COPY server/agent/guard.ts server/agent/env-scrub.ts server/agent/agentcore-approvals.ts server/agent/tool-policy.ts ./shared/agent/
COPY server/real-path.ts ./shared/real-path.ts

# Compile + bundle → dist/index.mjs (no external runtime deps; node:* built-ins only)
RUN node build.mjs


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

# System packages needed to install kiro-cli
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl \
      unzip \
      ca-certificates \
      bash \
      git \
      python3 \
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

# uv / uvx (Python tools and uvx-based MCP servers) are part of the image, so nothing is downloaded when a run starts.
# Python itself comes from the image too (UV_PYTHON_PREFERENCE=system), so uv does not fetch an interpreter.
COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_PREFERENCE=system

# The draw.io MCP server (lookups for icon diagrams) and its shape index, pinned, so a run needs no network for them.
# Same versions as the portal's Icon diagrams pack (server/drawio-pack.ts). Run as an integration named "drawio".
ENV DRAWIO_MCP_HOME=/opt/drawio-mcp
RUN npm install --prefix /opt/drawio-mcp --ignore-scripts --no-audit --no-fund --save-exact @drawio/mcp@1.10.0 &&     node -e "const c=require('crypto'),f=require('fs');fetch('https://raw.githubusercontent.com/jgraph/drawio-mcp/c9cc979ea66d440a0735ef3a4289962af11ee2de/shape-search/search-index.json').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(b=>{const h=c.createHash('sha256').update(Buffer.from(b)).digest('hex');if(h!=='d32fe548100b0c73fbbbc66609e294a2dd766b1e52406774ba68f6a8449c5186')throw new Error('shape index checksum '+h);f.writeFileSync('/opt/drawio-mcp/shape-index.json',Buffer.from(b))}).catch(e=>{console.error(e.message);process.exit(1)})" &&     chmod -R a+rX /opt/drawio-mcp

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
