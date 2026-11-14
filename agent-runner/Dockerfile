# agent-runner — Amazon Bedrock AgentCore Runtime container
# Platform: linux/arm64 (required by AgentCore Runtime)
# Build context: repo root (so we can COPY server/agent/guard.ts and env-scrub.ts)
#
# Usage:
#   docker buildx build --platform linux/arm64 --load \
#     -f agent-runner/Dockerfile -t agent-runner:local .

# ── Stage 1: builder ──────────────────────────────────────────────────────────
# Base image; CodeBuild passes AWS's public ECR mirror (public.ecr.aws/docker/library/node:22-slim).
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS builder

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
# run.ts imports them from ../shared/agent/*.ts and ../shared/real-path.ts (same layout as server/), and its own
# modules from ../shared/runner-*.ts.
COPY server/agent/guard.ts server/agent/env-scrub.ts server/agent/tool-policy.ts server/agent/pricing.ts server/agent/agentcore-approvals.ts ./shared/agent/
COPY server/real-path.ts ./shared/real-path.ts
COPY server/agent/runner-files.ts ./shared/runner-files.ts
COPY server/agent/runner-repos.ts ./shared/runner-repos.ts
COPY server/agent/runner-inspect.ts ./shared/runner-inspect.ts
COPY server/agent/runner-snapshot.ts ./shared/runner-snapshot.ts
COPY server/agent/runner-terminal.ts ./shared/runner-terminal.ts
COPY server/agent/runner-terminal-auth.ts ./shared/runner-terminal-auth.ts
COPY server/agent/runner-mcp.ts ./shared/runner-mcp.ts
COPY server/agent/runner-checks.ts ./shared/runner-checks.ts
COPY server/agent/runner-finalize.ts ./shared/runner-finalize.ts
COPY server/agent/runner-finalize-run.ts ./shared/runner-finalize-run.ts
COPY server/agent/runner-memory.ts ./shared/runner-memory.ts
COPY server/agent/runner-graph.ts ./shared/runner-graph.ts

# Compile + bundle → dist/index.mjs
# @anthropic-ai/claude-agent-sdk stays external (installed in runtime stage)
RUN node build.mjs


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

# git (clones in repo-based runs), curl and python3 (tools the agent commonly needs)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates curl python3 && \
    rm -rf /var/lib/apt/lists/*

# uv / uvx (Python tools and uvx-based MCP servers) are part of the image, so nothing is downloaded when a run starts.
# Python itself comes from the image too (UV_PYTHON_PREFERENCE=system), so uv does not fetch an interpreter.
COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_PREFERENCE=system
# graphify: a code knowledge graph of each cloned repository, built after the clone (server/agent/runner-graph.ts) and queried
# by the agent with `graphify query|path|explain`. Pinned; installed into /opt so the non-root user can run it. Local only (no key, no network at run time).
ENV UV_PYTHON_DOWNLOADS=never UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin
RUN uv tool install graphifyy==0.9.108 && chmod -R a+rX /opt/uv-tools && command -v graphify


# The draw.io MCP server (lookups for icon diagrams) and its shape index, pinned, so a run needs no network for them.
# Same versions as the portal's Icon diagrams pack (server/drawio-pack.ts). Run as an integration named "drawio".
ENV DRAWIO_MCP_HOME=/opt/drawio-mcp
RUN npm install --prefix /opt/drawio-mcp --ignore-scripts --no-audit --no-fund --save-exact @drawio/mcp@1.10.0 &&     node -e "const c=require('crypto'),f=require('fs');fetch('https://raw.githubusercontent.com/jgraph/drawio-mcp/c9cc979ea66d440a0735ef3a4289962af11ee2de/shape-search/search-index.json').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(b=>{const h=c.createHash('sha256').update(Buffer.from(b)).digest('hex');if(h!=='d32fe548100b0c73fbbbc66609e294a2dd766b1e52406774ba68f6a8449c5186')throw new Error('shape index checksum '+h);f.writeFileSync('/opt/drawio-mcp/shape-index.json',Buffer.from(b))}).catch(e=>{console.error(e.message);process.exit(1)})" &&     chmod -R a+rX /opt/drawio-mcp

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
