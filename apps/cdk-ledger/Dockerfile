ARG BUILDPLATFORM

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# 聚合站点公开前缀，构建期注入（AllInOne PRD §8.1）。
ARG NEXT_PUBLIC_BASE_PATH=/ledger
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json next.config.ts tsconfig.json next-env.d.ts ./
COPY postcss.config.mjs eslint.config.mjs ./
COPY public ./public
COPY src ./src
RUN npm run build
RUN rm -rf .next/standalone/node_modules/sharp .next/standalone/node_modules/@img

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY db ./db
COPY scripts ./scripts
COPY scripts/start.mjs ./scripts/start.mjs
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
