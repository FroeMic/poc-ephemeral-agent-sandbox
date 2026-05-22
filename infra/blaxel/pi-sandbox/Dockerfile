FROM node:22-alpine

RUN apk update && apk add --no-cache \
  bash \
  git \
  curl \
  netcat-openbsd \
  ripgrep \
  && rm -rf /var/cache/apk/*

WORKDIR /app

COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api

RUN mkdir -p /app \
  && npx create-next-app@latest /app --use-npm --typescript --eslint --tailwind --src-dir --app --import-alias "@/*" --no-git --yes --no-turbopack

RUN mkdir -p /agentruntime/harness \
  && cd /agentruntime/harness \
  && npm init -y \
  && npm install --omit=dev @earendil-works/pi-coding-agent@0.75.4 \
  && npm cache clean --force

EXPOSE 3000

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PATH="/usr/local/bin:/app/node_modules/.bin:$PATH"

ENTRYPOINT ["/entrypoint.sh"]
