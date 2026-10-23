# AllInOne · 我的工具箱

个人工具聚合站点：统一入口、独立工具。方案与验收标准见 [PRD.md](PRD.md)。

## 当前状态

- **M1（进行中）**：门户骨架 —— 工具目录配置、首页（搜索/分类/收藏/最近打开）、工具详情、状态页、偏好页、状态 API、Caddy 网关、CI 与 GHCR 自动发布。
- **M2（待开始）**：三个现有工具接入（复制源码到 `apps/`，子路径适配与公共导航；原始仓库保持只读）。

## 结构

```
AllInOne/
├── apps/portal/        # 门户（Next.js 16 + TS，仅门户自己的技术栈）
├── config/             # 工具目录与分类（事实源）；health.json.example 为部署专用示例
├── deploy/             # compose + Caddyfile + .env.example
├── scripts/            # validate-config.ts 等工程脚本
└── docs/               # 接入与运维文档（随里程碑补充）
```

## 常用命令

```bash
# 配置校验（Node 22+，无需安装依赖）
node --experimental-strip-types scripts/validate-config.ts

# 门户
cd apps/portal
pnpm install
pnpm test          # 纯逻辑单元测试（node:test）
pnpm build         # 类型检查 + 构建
pnpm dev           # 本地开发（可选）
```

## 发布与部署

推送到 `main` 后，GitHub Actions 自动构建 `linux/amd64` 与 `linux/arm64` 镜像并发布到 `ghcr.io/xxoxxsxx`，NAS 直接拉取（PRD §11.2）：

```bash
cd deploy
cp .env.example .env   # 首次：填入实际值
docker compose pull
docker compose up -d
```

## 约定

- `cdk-ledger-app`、`GrBorder`、`TickerSentry` 三个原始仓库为只读参考源，任何修改只发生在 `apps/` 下的副本。
- 工具接入前缀：`/ledger`、`/stocks`、`/framelab`；门户保留 `/tools`、`/status`、`/preferences`、`/api`、`/_next`。
- 密钥与连接串只存在于 NAS 的 `deploy/.env`（gitignore），不进入 Git 与文档。
