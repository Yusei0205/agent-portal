ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY server ./server
COPY cursor-runner ./cursor-runner
RUN node cursor-runner/build.mjs

FROM ${NODE_IMAGE}
# The Cursor CLI is a pinned tarball (not the moving installer script); the same version string names the arm64 and x64 builds.
ARG CURSOR_VERSION=2026.11.19-f005e9d
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git tar gzip python3 \
 && rm -rf /var/lib/apt/lists/* \
 && case "${TARGETARCH:-$(dpkg --print-architecture)}" in arm64) A=arm64;; *) A=x64;; esac \
 && mkdir -p /opt/cursor-agent \
 && curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/${A}/agent-cli-package.tar.gz" | tar --strip-components=1 -xzf - -C /opt/cursor-agent \
 && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/agent \
 && agent --version
COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_PREFERENCE=system
# graphify: a code knowledge graph of each cloned repository (server/agent/runner-graph.ts); pinned, installed into /opt so the non-root user can run it.
ENV UV_PYTHON_DOWNLOADS=never UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin
RUN uv tool install graphifyy==0.9.108 && chmod -R a+rX /opt/uv-tools && command -v graphify
WORKDIR /app
COPY --from=build /src/cursor-runner/dist ./dist
COPY --from=build /src/node_modules/ws ./node_modules/ws
COPY --from=build /src/node_modules/@lydell ./node_modules/@lydell
ENV NODE_ENV=production PORTAL_CURSOR_BIN=/usr/local/bin/agent AGENT_RUNNER_PORT=8080
USER node
EXPOSE 8080
CMD ["node", "dist/index.mjs"]
