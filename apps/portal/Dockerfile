# 构建阶段（本机不要求运行，CI/NAS 均可构建；PRD §11.1）
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期不需要读取 config（页面均为动态渲染），PORTAL_CONFIG_DIR 仅为兜底。
RUN corepack enable && pnpm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
