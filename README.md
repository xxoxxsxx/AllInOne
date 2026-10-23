# AllInOne · 个人工具网站（v2 单镜像）

一个 Next.js 16 应用聚合个人工具：门户 + CDK 台账 + 股票提醒 + Frame Lab 相机拼图。
架构与验收标准见 [PRD.md](PRD.md)（v2 单镜像统一架构；v1 多镜像方案存档于 docs/）。

## 部署（NAS，只拉取不构建）

```bash
cd deploy && cp .env.example .env   # 填 ALLINONE_DATA_DIR 等
docker compose pull && docker compose up -d
```

数据卷 `/data`：`cdk/cdk.db`（自 PostgreSQL 一次性迁移，脚本见 scripts/migrate-pg-to-sqlite.ts）
与 `tickersentry/ticker.db`（直接沿用原文件）。

## 开发

```bash
cd apps/allinone
pnpm install
pnpm dev        # http://localhost:3000
pnpm test       # node --test 单元测试
pnpm build      # 类型检查 + 构建
```

工具目录：`config/tools.json`。推送到 main 后 Actions 自动构建 linux/amd64+arm64 镜像并发布 GHCR。

## 约定

- `cdk-ledger-app`、`GrBorder`、`TickerSentry` 原始仓库只读；AllInOne 内是副本。
- 添加新工具：`src/modules/<id>/`（或纯静态 `public/<id>/`）+ `config/tools.json` 登记（PRD §5.1）。
