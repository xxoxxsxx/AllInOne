# Deployment Guide

## Recommended Flow

- GitHub Actions 构建镜像
- 镜像发布到 `GHCR`
- NAS 只负责 `docker compose pull` 和 `docker compose up -d`
- 数据库继续使用你现有的 `PostgreSQL`
- 访问只通过 `Tailscale`

当前仓库包含：

- 本地构建用 `compose.yaml`
- NAS 拉镜像用 `compose.ghcr.yaml`
- GitHub 发布工作流 `.github/workflows/docker-publish.yml`

如果你的 NAS 还是老版本 Docker CLI，文档里的 `docker compose` 可以直接替换成 `docker-compose`。

## 1. GitHub Build And Publish

工作流触发条件：

- push 到 `main`
- push tag，例如 `v1.0.0`
- 手动触发 `workflow_dispatch`

发布后的镜像地址为：

```text
ghcr.io/xxoxxsxx/cdk-ledger-app
```

常用标签：

- `main`
- `latest`
- `sha-xxxxxxx`
- `v1.0.0`

如果首次运行工作流时提示权限不足，到 GitHub 仓库里检查：

`Settings -> Actions -> General -> Workflow permissions`

建议设置为 `Read and write permissions`。

如果你希望 NAS 无需登录即可拉取镜像，可以把 GHCR package 调整为 public。否则保留 private，并在 NAS 上执行一次 `docker login`。

## 2. Prepare NAS Env

在 NAS 上准备目录，并放入 `compose.ghcr.yaml` 与 `.env`。

`.env` 示例：

```env
APP_IMAGE=ghcr.io/xxoxxsxx/cdk-ledger-app:main
DATABASE_URL=postgresql://postgres:password@192.168.1.10:5432/cdk_ledger
APP_PORT=3000
TZ=Asia/Shanghai
NEXT_TELEMETRY_DISABLED=1
```

说明：

- `APP_IMAGE` 建议默认用 `:main`
- 如果你要固定某次发布版本，可以改成 `:v1.0.0` 或 `:sha-xxxxxxx`
- `DATABASE_URL` 指向你现有 PostgreSQL

如果镜像是 private，在 NAS 上先登录：

```bash
docker login ghcr.io -u GITHUB_USERNAME
```

密码使用 GitHub PAT，至少包含：

- `read:packages`

## 3. Init Database

当前运行镜像已经包含 `db` 和 `scripts`，所以首次建库可以直接在 NAS 上执行：

```bash
docker compose -f compose.ghcr.yaml run --rm app node scripts/db-migrate.mjs
docker compose -f compose.ghcr.yaml run --rm app node scripts/db-seed.mjs
docker compose -f compose.ghcr.yaml run --rm app node scripts/db-check.mjs
```

以上全量迁移仅用于首次建库。现有数据库升级应指定新增迁移文件，避免重跑旧版本约束。

### 退款功能升级（已有 0001–0006 的数据库）

先备份数据库，拉取新镜像后启动应用；启动时会自动补齐缺失迁移：

```bash
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
docker compose -f compose.ghcr.yaml logs app
```

本地等价命令为 `npm run db:migrate -- 0007_refunds.sql` 和 `npm run db:check`。新迁移可重复执行，不修改历史发货金额，也不自动推算历史作废退款。应用启动时会自动应用未执行的迁移；如需手动执行，仍可运行 `docker compose -f compose.ghcr.yaml run --rm app node scripts/db-migrate.mjs 0007_refunds.sql`。

## 4. Start Or Upgrade

首次启动：

```bash
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
```

后续升级也一样：

```bash
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
```

默认容器内监听 `3000`，宿主映射由 `APP_PORT` 控制。

## 5. Verify Health

启动后检查：

```bash
curl http://NAS_IP:APP_PORT/api/health
```

期望返回：

```json
{
  "ok": true,
  "database": "up"
}
```

如果返回 `503`，优先检查：

- `DATABASE_URL` 是否可达
- PostgreSQL 是否允许 NAS 宿主或容器网络访问
- 数据库防火墙或白名单

## 6. Tailscale Access

通过 Tailscale 访问时，使用：

```text
http://TAILSCALE_IP:APP_PORT
```

建议至少验证：

- 首页可打开
- `/events/new` 可打开并提交
- `/config` 可打开并保存配置
- `/events` 可筛选
- `/events/export` 可导出

## 7. Manual Checklist

- 可新增套餐类型
- 可新增下游对象
- 可启用和停用配置项
- 可新增 `issue_self`
- 可新增 `issue_reseller`
- 可新增 `void`
- 可新增 `replace`
- 重复有效 CDK 会被阻止
- 首页能看到 4 个统计卡片
- 首页能看到最近 10 条事件
- `/events` 可按日期、事件类型、CDK、套餐类型、下游对象筛选
- `/events/export` 可导出当前筛选结果

## 8. Notes

- 当前仓库已包含 `/api/health` 健康检查接口
- 当前环境未做真实 NAS / Tailscale / PostgreSQL 联调，以上步骤需要在你的实际环境执行
