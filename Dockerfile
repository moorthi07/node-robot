# node-robot — RRCA runtime
#
# node:18-bookworm-slim builds on both amd64 and arm64 (Raspberry Pi), so the
# same image runs on a dev box, a server, or on the robot's own compute.

FROM node:18-bookworm-slim

WORKDIR /app

# The local RRCF node package is a file: dependency, so it must be present before
# `npm install` resolves it. Copy manifests + the package, then install.
COPY package.json package-lock.json* ./
COPY packages ./packages

RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

# Node-RED runtime state.
VOLUME ["/app/data"]

EXPOSE 1880

ENV NODE_ENV=production

CMD ["node", "index.js"]
