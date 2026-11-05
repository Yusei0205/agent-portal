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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git tar gzip \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@${CODEX_VERSION} \
 && codex --version
WORKDIR /app
COPY --from=build /src/codex-runner/dist ./dist
ENV NODE_ENV=production PORTAL_CODEX_BIN=/usr/local/bin/codex AGENT_RUNNER_PORT=8080
USER node
EXPOSE 8080
CMD ["node", "dist/index.mjs"]
