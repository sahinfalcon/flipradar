FROM node:22-bookworm-slim
WORKDIR /app
# Build tools in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/flipradar.db
VOLUME ["/data"]
CMD ["npx", "tsx", "src/main.ts"]
