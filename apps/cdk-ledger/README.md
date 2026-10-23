# cdk-ledger-app

CDK 台账 MVP。技术栈固定为 `Next.js + TypeScript + Tailwind CSS + PostgreSQL`，部署目标是 `Docker on NAS`，访问边界是 `Tailscale` 内网。

## Local

```bash
npm install
npm run dev
```

默认地址：`http://localhost:3000`

## Environment

复制 `.env.example` 并填入实际值：

```bash
cp .env.example .env.local
```

Phase 3 已接入 PostgreSQL 约定，应用和数据库脚本共用 `DATABASE_URL`。

## Database

首次建库：

```bash
npm run db:migrate
npm run db:seed
```

结构检查：

```bash
npm run db:check
```

当前默认初始化数据：

- `packages`: `plus`, `5xpro`, `20xpro`
- `resellers`: 空

## Docker

```bash
docker compose up --build
```

默认对外端口由 `APP_PORT` 控制，容器内固定为 `3000`。

如果你要用 GitHub 自动打包并让 NAS 直接拉镜像部署：

- push 到 `main` 后，GitHub Actions 会发布镜像到 `ghcr.io/xxoxxsxx/cdk-ledger-app`
- NAS 使用 `compose.ghcr.yaml`
- 详细步骤见 `docs/DEPLOY.md`

健康检查接口：

```bash
curl http://localhost:3000/api/health
```

## Structure

- `src/app`: App Router 页面和全局样式
- `src/components`: 可复用 UI 组件
- `src/lib`: 通用工具和后续数据库接入代码
- `db/migrations`: PostgreSQL 迁移 SQL
- `db/seeds`: 初始化数据 SQL
- `scripts`: 数据库执行脚本
- `docs`: 产品文档

## Naming

- 目录与文件统一使用短横线或框架默认命名
- React 组件使用 `PascalCase`
- 工具函数使用短小明确的动词或名词组合
- 避免缩写不清、避免无意义中间层
