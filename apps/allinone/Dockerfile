# AllInOne v2 唯一应用镜像。better-sqlite3 需要原生编译，deps 阶段补齐构建工具。
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/data
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Frame Lab 是 public/framelab 静态资源；standalone 不含 public，必须单独复制。
COPY --from=builder /app/public ./public
# 工具目录配置随镜像发布（更新工具清单 = 发布新镜像）。
COPY --from=builder /app/config ./config
ENV PORTAL_CONFIG_DIR=/app/config
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
