FROM node:22-alpine AS build
WORKDIR /workspace/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend
RUN apk add --no-cache tini \
  && chown -R node:node /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force
COPY --from=build --chown=node:node /workspace/backend/dist ./dist
COPY --chown=node:node database/migrations ./database/migrations
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/api/main.js"]
