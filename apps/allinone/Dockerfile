# AllInOne v2 唯一应用镜像。
# 原生依赖按目标平台安装：better-sqlite3 单独在 sqlite 阶段（无 BUILDPLATFORM 固定）
# 安装，保证 arm64/amd64 镜像各自带正确架构的二进制。

# ---- 依赖（构建平台，快速）：next build 所需的纯 JS 依赖 ----
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

# ---- better-sqlite3（目标平台）：正确架构的原生二进制 ----
FROM node:22-bookworm-slim AS sqlite
WORKDIR /sqlite
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm init -y >/dev/null 2>&1 \
 && npm install --no-audit --no-fund better-sqlite3@12.11.1 \
 && node -e "const db=require('better-sqlite3')(':memory:'); db.exec('select 1'); console.log('sqlite stage ok')"

# ---- 构建（构建平台）：next build 只产出与架构无关的 JS ----
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# 构建期禁用调度器：register() 在 build 阶段也会执行，不应建库/起任务。
ENV DISABLE_SCHEDULER=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm run build

# ---- 运行（目标平台）----
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
# 用目标平台的 better-sqlite3（含正确架构二进制 + bindings）替换追踪进来的版本，
# 然后当场 require + 建内存库验证：缺东西让构建失败，而不是部署后 500。
COPY --from=sqlite /sqlite/node_modules/better-sqlite3 /pkg/better-sqlite3
COPY --from=sqlite /sqlite/node_modules/bindings /pkg/bindings
RUN DST=$(find /app/node_modules -type d -name better-sqlite3 -path "*node_modules/better-sqlite3" | head -1) \
 && test -n "$DST" \
 && rm -rf "$DST" \
 && mkdir -p "$DST" "$(dirname "$DST")/bindings" \
 && cp -r /pkg/better-sqlite3/. "$DST/" \
 && cp -r /pkg/bindings/. "$(dirname "$DST")/bindings/" \
 && rm -rf /pkg \
 && node -e "const db=require('better-sqlite3')(':memory:'); db.exec('select 1'); console.log('better-sqlite3 runtime ok')"
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
