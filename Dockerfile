# Agent Portal: one container, one data volume.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
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
USER portal
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.mjs"]
