# Coding Agent, packaged to run unattended on a NAS (or any Docker host) rather
# than as a local process on a dev machine. See ARCHITECTURE.md's "Container
# deployment" section for the full rationale and required run-time configuration.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY schemas ./schemas
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app

# git: worktree operations. docker-cli: lets the container drive the HOST's
# Docker engine via a mounted socket, for the docker_build validation gate —
# this is NOT Docker-in-Docker, it's the standard "mount the host socket"
# pattern, so containers/images it builds land in the host's Docker, not a
# nested throwaway daemon.
RUN apk add --no-cache git docker-cli

# Explicit, hermetic Claude CLI install rather than relying on whatever the SDK
# may or may not bundle — guarantees `claude` is on PATH in a from-scratch image.
RUN npm install -g @anthropic-ai/claude-code

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/schemas ./schemas
COPY examples ./examples

ENTRYPOINT ["node", "dist/cli.js"]
