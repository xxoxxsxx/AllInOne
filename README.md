# AllInOne · 个人工具网站

一个 Next.js 16 应用聚合个人工具：门户 + CDK 台账 + 股票提醒 + 旅行攻略 + 证件夹 + Frame Lab 相机拼图。
架构与验收标准见 [PRD.md](PRD.md)。

## 功能一览

| 工具 | 说明 |
|---|---|
| CDK 台账 | CDK 发货、代发、作废与换新记录 |
| 股票提醒 | 档位触价监控，支持 Bark / 飞书 / Telegram 推送 |
| 旅行攻略 | 按天安排地点、地图标注、收集照片与链接 |
| 证件夹 | 证件有效期管理、扫描件附件、到期提醒推送、备份导出 |
| Frame Lab | 浏览器本地相机拼图导出 |
| 其他 | 二维码工具、摄影拼图等静态小工具 |

## 部署（拉取镜像即可）

```bash
cd deploy && cp .env.example .env   # 按注释填写
docker compose pull && docker compose up -d
```

数据保存在 `/data` 数据卷（SQLite）。推送到 main 后 Actions 自动构建 linux/amd64 + arm64 镜像并发布 GHCR。

## 开发

```bash
cd apps/allinone
pnpm install
pnpm dev        # http://localhost:3000
pnpm test       # node --test 单元测试
pnpm build      # 类型检查 + 构建
```

## 约定

- 添加新工具：`src/app/<id>/`（或纯静态 `public/<id>/`）+ 在 `config/tools.json` 登记。
- 模块文档见 [docs/documents.md](docs/documents.md) 等对应说明。
