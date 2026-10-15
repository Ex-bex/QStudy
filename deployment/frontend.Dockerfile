FROM node:24-bookworm-slim AS build

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs", "--hostname", "0.0.0.0", "--port", "3000"]
