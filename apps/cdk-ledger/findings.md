# Findings & Decisions

## Requirements

- 系统是单用户 CDK 台账，不是财务记账系统
- 部署方式固定为 Docker on NAS
- 数据库存储使用现有 PostgreSQL
- 访问方式仅限内网，通过 Tailscale 进入
- 不提供应用内登录
- 支持 4 类事件：`issue_self`、`issue_reseller`、`void`、`replace`
- 支持 2 张配置表：`packages`、`resellers`
- 支持 CSV 导出
- 所有记录都必须保留 `created_at` 与 `updated_at` 双字段，首次创建时 `updated_at` 可为空

## Research Findings

- 当前仓库只有一份最新 PRD，业务与技术约束都已写入其中
- 当前目录不是 git 仓库，验证修改时需要依赖文本比对而不是 `git diff`
- 文档已从旧的 Supabase/财务版 PRD 收缩为内网 CDK 台账版
- 当前项目骨架已初始化完成，可直接进入数据库建模阶段
- 当前环境没有可用 Docker daemon，也没有 `psql` 客户端，无法做本地实库验证
- 基础配置页已落地，当前支持新增、启停、删除未引用项
- 事件录入页已落地，当前支持 4 类事件表单和服务端校验
- 仪表盘、明细页和 CSV 导出已落地，查询口径已统一
- 已补充部署说明和健康检查接口，但尚未做真实 NAS / Tailscale / PostgreSQL 验证

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Next.js 作为应用层 | 与当前 PRD 技术方案一致，适合表单、筛选和导出 |
| PostgreSQL 作为唯一数据库 | 已有现成实例，稳定支持多设备访问 |
| 基础配置使用 `packages` / `resellers` 表 | 满足“可配置且可启停”的业务要求 |
| Docker on NAS 作为首版部署方式 | 与用户现有环境匹配，减少平台切换成本 |
| Tailscale 作为访问边界 | 明确系统仅限内网，不需要应用内认证 |
| Docker 使用 `standalone` 多阶段构建 | 产物更小，适合 NAS 长期运行 |
| 首版保留最小目录结构 | 先保证可运行与可部署，再在 Phase 3 接数据库 |
| 本地脚本使用 webpack 模式 | 避开 Next 16 默认 Turbopack 在当前环境下的稳定性问题 |
| 数据库迁移使用原生 SQL + `pg` 脚本 | 简单、可审查、便于直接对现有 PostgreSQL 执行 |
| 默认 seed 只写 `packages`，不写 `resellers` | 当前已知套餐有固定值，下游对象暂无初始清单 |
| 基础配置使用服务端渲染 + server action | 不引入额外客户端状态层，移动端也足够轻量 |
| 事件录入使用单页分类型表单 + server action | 结构简单，后续易接入提交校验和成功反馈 |
| 仪表盘活跃统计先用服务端顺序归并算法 | 当前数据量下足够清晰，避免过度复杂 SQL |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| 原 PRD 与最终方向差异过大，局部修补会继续自相矛盾 | 直接重写 PRD 主体，统一业务与部署口径 |

## Resources

- PRD: [docs/PRD.md](/Users/limpidity/dev/github/cdk-ledger-app/docs/PRD.md)
- Task plan: [task_plan.md](/Users/limpidity/dev/github/cdk-ledger-app/task_plan.md)
- Migration: [db/migrations/0001_init.sql](/Users/limpidity/dev/github/cdk-ledger-app/db/migrations/0001_init.sql)
- Seed: [db/seeds/0001_base.sql](/Users/limpidity/dev/github/cdk-ledger-app/db/seeds/0001_base.sql)

## Visual/Browser Findings

- 无
