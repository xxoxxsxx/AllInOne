# Task Plan: CDK Ledger App MVP

## Goal

基于当前 PRD，完成一个运行在 NAS Docker 上、使用 PostgreSQL 存储、通过 Tailscale 内网访问的单用户 CDK 台账 MVP。

## Current Phase

Phase 7

## Phases

### Phase 1: Requirements & Scope Freeze

- [x] 读取并整理最新 PRD
- [x] 明确部署约束：Docker on NAS + PostgreSQL + Tailscale
- [x] 明确业务范围：4 类事件、2 张配置表、无应用内登录
- [x] 输出可执行任务文档
- **Status:** complete

### Phase 2: Project Bootstrap

- [x] 初始化 Next.js + TypeScript + Tailwind 项目
- [x] 增加 Dockerfile 与运行配置
- [x] 增加环境变量模板
- [x] 明确目录结构与命名约定
- **Status:** complete

### Phase 3: Database Schema & Seed

- [x] 建立 `events`、`packages`、`resellers` 表
- [x] 实现 `created_at` / `updated_at` 双字段约束
- [x] 初始化默认套餐类型
- [x] 初始化默认下游对象
- [x] 验证关键约束与索引
- **Status:** complete

### Phase 4: Configuration Management

- [x] 完成基础配置页
- [x] 支持新增、启用、停用套餐类型
- [x] 支持新增、启用、停用下游对象
- [x] 阻止删除已被引用的配置项
- **Status:** complete

### Phase 5: Event Entry Flow

- [x] 完成 `issue_self` 表单
- [x] 完成 `issue_reseller` 表单
- [x] 完成 `void` 表单
- [x] 完成 `replace` 表单
- [x] 实现提交校验与成功反馈
- **Status:** complete

### Phase 6: Query, Dashboard & Export

- [x] 完成仪表盘计数查询
- [x] 完成最近 10 条事件列表
- [x] 完成明细页筛选：日期、事件类型、CDK、套餐类型、下游对象
- [x] 完成明细页分页与连续序号
- [x] 完成作废事件高亮显示
- [x] 完成录入页整段文本粘贴识别 CDK
- [x] 完成 CSV 导出
- [x] 确保导出与明细筛选共用同一套查询逻辑
- [x] 为 CSV 导出增加 `5000` 条上限
- **Status:** complete

### Phase 7: NAS Deployment & Verification

- [ ] 验证容器内连接 PostgreSQL
- [ ] 验证 Tailscale 内访问
- [ ] 验证手机端表单可用性
- [ ] 跑完 PRD 手工测试清单
- [ ] 整理交付说明
- **Status:** pending

## Key Questions

1. 基础配置页后续是否需要支持修改 `name`？
2. 后续是否需要补一套开发用本地 PostgreSQL 容器脚本？
3. NAS 上 PostgreSQL 是否需要 SSL 连接参数？

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| 使用 PostgreSQL 而不是 SQLite | 已有现成 PG，且该系统为多设备访问应用 |
| 不做应用内登录 | 系统仅限内网，通过 Tailscale 访问，认证复杂度不值得保留 |
| 采用事件流模型 | 便于追溯 CDK 状态变化，避免手工维护最终态 |
| 套餐类型与下游对象独立建表 | 避免硬编码，支持后续持续变化 |
| 所有记录保留 `created_at` 与 `updated_at` | 满足审计与后续配置变更追踪 |
| Phase 3 采用原生 SQL 迁移 | 对现有 PG 最直接，后续 NAS 执行和排障成本最低 |
| 默认套餐初始化为 `plus`、`5xpro`、`20xpro` | 与当前已知业务输入一致 |
| 默认下游对象初始化为空 | 当前没有现成清单，后续由配置页维护 |
| Phase 4 首版不做配置项编辑 | 保持规则简单，避免引入额外表单和审计复杂度 |
| Phase 5 采用单页事件录入 + URL 切换类型 | 无需额外客户端状态管理，手机端也更稳定 |
| 当前有效 CDK 判断集中在 `src/lib/events.ts` | 后续仪表盘、明细和导出可复用同一套口径 |
| Phase 6 的筛选与导出共用 `parseEventFilters` + `listEventDetails` | 保证页面展示和导出口径完全一致 |
| 明细页分页采用服务端 `page + limit/offset` | 避免一次性拉取全部事件，后续数据量增长时仍可控 |
| 明细序号按当前筛选结果全局连续计算 | 翻页后可直接对照人工台账，不会每页重新从 1 开始 |
| 导出上限固定为 `5000` 条 | 当前为单用户内网台账，同步 CSV 导出不应放大到全库级别 |
| CDK 识别仅做文本提取，不做 OCR 或自动提交 | 保持输入辅助简单可控，不扩大实现范围 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| 当前目录不是 git 仓库，无法用 `git diff` 校验 | 1 | 改用 `rg` 与全文复核校验文档一致性 |
| Next 16 默认 `Turbopack` 构建在当前环境下触发进程绑定端口错误 | 1 | 改为 `next build --webpack` 与 `next dev --webpack`，保持本地和 Docker 构建稳定 |

## Notes

- 当前 PRD 版本为 `v1.3`
- 实现应严格对齐 [docs/PRD.md](/Users/limpidity/dev/github/cdk-ledger-app/docs/PRD.md)
- 关键数据库文件位于 `db/migrations`、`db/seeds` 与 `scripts`
