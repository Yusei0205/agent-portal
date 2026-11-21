ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY server ./server
COPY codex-runner ./codex-runner
RUN node codex-runner/build.mjs

FROM ${NODE_IMAGE}
ARG CODEX_VERSION=0.166.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git tar gzip python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@${CODEX_VERSION} \
 && codex --version
COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_PREFERENCE=system
# graphify: a code knowledge graph of each cloned repository, built after the clone (server/agent/runner-graph.ts) and queried
# by the agent with `graphify query|path|explain`. Pinned; installed into /opt so the non-root user can run it. Local only (no key, no network at run time).
ENV UV_PYTHON_DOWNLOADS=never UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin
RUN uv tool install graphifyy==0.9.108 && chmod -R a+rX /opt/uv-tools && command -v graphify
WORKDIR /app
COPY --from=build /src/codex-runner/dist ./dist
COPY --from=build /src/node_modules/ws ./node_modules/ws
COPY --from=build /src/node_modules/@lydell ./node_modules/@lydell
ENV NODE_ENV=production PORTAL_CODEX_BIN=/usr/local/bin/codex AGENT_RUNNER_PORT=8080
USER node
EXPOSE 8080
CMD ["node", "dist/index.mjs"]
