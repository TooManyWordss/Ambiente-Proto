# Builds the café system for a cloud host (Northflank, Render, Fly.io…). The sales databases live in
# DATA_DIR, which must be a persistent volume mounted at /data, or every restart starts from empty.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TZ=Asia/Manila
EXPOSE 8080
CMD ["node", "server.js"]
