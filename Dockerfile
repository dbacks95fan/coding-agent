# Copyright (c) 2026 DPSystems, LLC.
# ABOUTME: Container image for the Coding Agent service: Node 24, Git, Bash, and Chromium's OS libraries for e2e checks.
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY schemas ./schemas
RUN npm run build && npm prune --omit=dev

FROM node:24.19.0-bookworm-slim
# Target repositories' end-to-end checks drive Chromium through Playwright. The OS
# libraries are baked in here; browser binaries are installed per repository by its
# manifest setup step into the shared cache volume, matching that repository's version.
ARG PLAYWRIGHT_DEPS_VERSION=1.62.1
RUN apt-get update \
  && apt-get install --no-install-recommends -y "bash=5.2.15-2+b13" "ca-certificates=20250419~deb12u2" "git=1:2.39.5-0+deb12u3" \
  && npx -y "playwright@${PLAYWRIGHT_DEPS_VERSION}" install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm \
  && useradd --system --uid 10001 --create-home --home-dir /home/agent agent
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/schemas ./schemas
USER agent
ENV PORT=8080 \
  CODING_AGENT_WORK_ROOT=/work \
  CODING_AGENT_MANIFEST=/config/manifest.json \
  CODING_AGENT_SHELL=bash
EXPOSE 8080
CMD ["node", "dist/cli.js", "serve"]
