# AllInOne v2 唯一应用镜像。better-sqlite3 需要原生编译，deps 阶段补齐构建工具。
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile && node -e "require('better-sqlite3')"

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# 构建期禁用调度器：register() 在 build 阶段也会执行，不应建库/起任务。
ENV DISABLE_SCHEDULER=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm run build
# Next 追踪原生 .node 二进制不稳定：构建后把它固定输出到 /out，
# 供 runner 层精确放置到运行时实际解析的 better-sqlite3 包目录内。
RUN SRC=$(find node_modules/.pnpm -path "*better-sqlite3/build/Release/better_sqlite3.node" | head -1) \
 && test -n "$SRC" \
 && mkdir -p /out \
 && cp "$SRC" /out/better_sqlite3.node

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/data
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORTAL_CONFIG_DIR=/app/config
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Frame Lab 是 public/framelab 静态资源；standalone 不含 public，必须单独复制。
COPY --from=builder /app/public ./public
# 工具目录配置随镜像发布（更新工具清单 = 发布新镜像）。
COPY --from=builder /app/config ./config
# 把原生二进制放进运行时 better-sqlite3 包目录（bindings 的搜索路径），
# 然后当场 require 验证：缺文件让构建失败，而不是部署后 500。
COPY --from=builder /out/better_sqlite3.node /tmp/better_sqlite3.node
RUN DST=$(find /app/node_modules -type d -name better-sqlite3 -path "*node_modules/better-sqlite3" | head -1) \
 && test -n "$DST" \
 && mkdir -p "$DST/build/Release" \
 && cp /tmp/better_sqlite3.node "$DST/build/Release/better_sqlite3.node" \
 && node -e "require('better-sqlite3'); console.log('better-sqlite3 runtime ok')" \
 && rm -f /tmp/better_sqlite3.node
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
