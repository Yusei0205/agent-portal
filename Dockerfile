# Agent Portal: one container, one data volume.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Install from the lockfile so the image is reproducible.
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# git for repositories; pandoc for .odt/.rtf/.epub uploads; awscli + git-remote-codecommit for CodeCommit;
# python-pptx, python-docx and docxtpl for the documentation and presentation role teams.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates pandoc python3-pip openssh-client \
 && pip3 install --no-cache-dir --break-system-packages awscli git-remote-codecommit python-pptx python-docx docxtpl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
RUN useradd -m -u 10001 portal && mkdir -p /data && chown portal /data

# CLI tools and config live on the data volume.
# HOME points there so Claude Code and AWS CLI config persist across container restarts.
# NOTE: the tool directories (/data/tools/bin, /data/home/.local/bin) are NOT on the
# default PATH here. The portal server passes absolute paths (uvx, kiro-cli) to the
# commands it spawns rather than relying on PATH lookup, which prevents a rogue write
# to these world-writable directories from escalating to code execution in later runs.
# See server/settings.ts agentEnv() which prepends them only when needed.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data \
    HOME=/data/home

# Ensure the per-user tool directories exist at image build time with the correct owner.
# The entrypoint script re-creates them at runtime (needed when /data is a fresh named volume).
RUN mkdir -p /data/home/.local/bin /data/tools/bin && chown -R portal /data

# Copy the entrypoint script.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER portal

# Use exec-form ENTRYPOINT so arguments passed to `docker run` / `docker compose run`
# are forwarded correctly (e.g. `docker run agent-portal node dist/preflight.mjs`).
# CMD supplies the default command (start the portal) when no arguments are given.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.mjs"]

VOLUME /data
EXPOSE 8787

# Health check via Node's built-in fetch — no curl required.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
