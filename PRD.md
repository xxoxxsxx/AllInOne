# AllInOne 个人工具网站 PRD v2（单镜像统一架构）

- 文档版本：v2.0
- 日期：2026-10-23
- 状态：架构已定稿、开发前草案；本文取代 v1.x 的多镜像/网关/子路径架构（原文存于 docs/PRD-v1.3-archived.md）
- 部署目标：单 Docker 镜像 + 单容器，NAS / 局域网 / Tailscale 私有访问
- 核心变化：门户、CDK 台账、Frame Lab、TickerSentry 全部并入一个 Next.js 应用；数据全部 SQLite；发布物只有一个镜像

## 1. 为什么有 v2

v1 方案按"异构技术栈、独立容器、网关聚合"实施到了 M2（三镜像已发布）。使用者在部署前提出新目标：**一个镜像发布、以后添加工具只用一种技术栈**。经评估确认：

1. 门户与 CDK 台账本就同为 Next.js 16 + React 19 + Tailwind，合并是搬路由而非重写；
2. 子路径挂载（basePath、BASE_PATH、Caddy 剥离/不剥离）是 v1 实施中全部棘手 bug 的来源，单应用后此类问题整体消失；
3. CDK 的负载（单用户手动录入）远低于 SQLite 能力边界，换 SQLite 可摆脱外部 PostgreSQL 依赖，备份退化为拷文件；
4. TickerSentry 是唯一异构项，使用者明确否决了"Go 子进程过渡"方案，选择直接 TypeScript 重写（一次性投入，换取此后永远单一技术栈）。

v1 的多镜像方案不删除：git 标签与镜像保留，作为 v2 验收前的回滚手段。

## 2. v1 结论的沿用与废止

| 事项 | v2 裁定 |
|---|---|
| 产品定位、单用户、私有网络 | 沿用 |
| 工具目录（3 工具）、分类、门户 UX 规格 | 沿用（首页/搜索/收藏/最近/详情/状态/偏好） |
| 三个原始仓库只读 | 沿用 |
| 单镜像、单容器 | **新增目标** |
| Caddy 网关、basePath/BASE_PATH 子路径适配 | **废止**（应用内原生路由） |
| CDK 用外部 PostgreSQL | **废止**（迁 SQLite，见 §6） |
| TickerSentry 保持 Go | **废止**（TS 重写，见 §7） |
| v1 验收矩阵 | 修订后沿用（§10） |
| 备份、回滚、观察期纪律 | 沿用并简化（§9） |

## 3. 目标架构

```text
ghcr.io/xxoxxsxx/allinone:main        ← 唯一镜像
└── Next.js 16 单应用（长驻 node 进程）
    ├── /                门户：工具卡片墙、搜索、状态页、偏好
    ├── /events/*        CDK 台账（业务代码自 v1 副本整体搬入）
    ├── /framelab/*      Frame Lab（public 静态资源）
    └── /stocks/*        TickerSentry（TS 重写，同应用内模块）
        └── 调度器：应用启动时注册的应用内定时任务（instrumentation）

数据卷 /data
├── cdk/cdk.db            CDK 台账（自 PostgreSQL 一次性迁移）
└── tickersentry/ticker.db  股票数据（直接沿用原 SQLite 文件）
```

- 单进程、单端口、无网关、无子路径、无 basePath。
- 容器崩溃 = 整站重启：已接受的取舍；所有状态（含调度计数）在 SQLite 中，重启后行为符合 TickerSentry 原有的"重启保留、离线不补跑"规则。
- 应用内调度与 Web 同进程：个人 NAS 单实例下成立；不承诺多实例部署。

## 4. 技术栈（定稿）

| 层 | 选型 | 说明 |
|---|---|---|
| 语言/框架 | TypeScript + Next.js 16（App Router）+ React 19 + Tailwind | 全项目唯一技术栈 |
| 运行时 | Node 22 LTS，`next start` 长驻进程 | 调度器随进程启动注册 |
| SQLite 驱动 | better-sqlite3（同步 API，WAL 模式） | 单用户场景最简可靠 |
| 金额 | TEXT 十进制串存储 + 整数分（或等价精确库）计算 | 沿用 CDK PRD"定点小数、不用浮点"原则；禁止 float |
| 行情/通知 | 原生 fetch；HTTP 代理用 undici ProxyAgent，SOCKS5 用 socks-proxy-agent | 与 TickerSentry 现有代理能力对齐 |
| 包管理 | pnpm（单应用单锁文件） | |

明确不做：微前端、多进程 supervisor、Kubernetes、应用内多语言插件机制。

## 5. 仓库结构（目标）

```text
AllInOne/
├── apps/
│   └── allinone/            # 唯一应用
│       ├── src/app/         # 路由：门户 / events / stocks / framelab 资源
│       ├── src/modules/
│       │   ├── ledger/      # CDK 台账模块（数据层、动作、页面）
│       │   ├── stocks/      # TickerSentry 模块（store、scheduler、quotes、notify）
│       │   └── framelab/    # 静态资源构建入口（产物进 public/framelab）
│       ├── src/lib/         # db(sqlite)、money、config 等共享层
│       └── public/framelab/
├── config/tools.json        # 工具目录（沿用 v1 格式，entry 改为站内路径）
├── scripts/                 # validate-config、migrate-pg-to-sqlite 等
├── deploy/                  # compose（单服务）+ .env.example
└── docs/
```

### 5.1 未来工具接入约定

1. 新工具 = `src/modules/<id>/` 一个目录 + `config/tools.json` 一条登记；
2. 纯前端工具放 `public/<id>/`，连模块目录都不需要；
3. 需要后台任务时向应用内调度器注册（统一串行队列，避免互相争抢）；
4. 数据默认 `/data/<id>/tool.db`（SQLite），备份即拷文件；
5. 不引入"工具商店/动态加载"机制——所有工具随镜像一体发布。

## 6. 数据层

### 6.1 CDK 台账：PostgreSQL → SQLite 一次性迁移

- 迁移脚本 `scripts/migrate-pg-to-sqlite.ts`：只读连接旧 PG，建 SQLite 库并导入 `packages`、`resellers`、`events` 及配置/平台/价格表；
- **金额换算**：PG `NUMERIC` → TEXT 十进制串原样保存；应用层计算用整数分，杜绝浮点误差；
- 唯一约束/去重规则（0002 迁移的 CDK 去重）必须在 SQLite 侧重建（UNIQUE INDEX + 插入前校验）；
- 验收：逐表行数一致、抽样事件逐字段比对、聚合汇总（各状态计数、毛利合计）与 PG 端一致；
- 旧 PG **只读不动**：切换前 `pg_dump` 存档；不删表、不清库，作为最终存档。

### 6.2 TickerSentry：文件直接沿用

- 原状 Go 版 schema 已到 v13；TS 版 store 接管同一 `ticker.db`，schema 版本号从 13 续排，不重置；
- 切换前对旧容器执行一次在线备份（`-backup`）并正常停止，确保 WAL 合并；
- better-sqlite3 与 modernc/sqlite 同为 SQLite 3 文件格式，无数据转换。

### 6.3 备份

- 日常：对 `/data` 两个目录做定时文件级备份（NAS 计划任务），保留 7 日 + 4 周；
- SQLite 一致性：备份脚本用各库的在线快照能力（better-sqlite3 `.backup()` / VACUUM INTO），不直接拷贝写入中的文件；
- 首次切换前后各做一次全量备份，旧 PG dump 与旧 ticker_data 原样保留。

## 7. TickerSentry TS 重写规格

原则：**行为忠实移植**，以原仓库 README、TASKS/PRD、既有 Go 测试用例为验收依据；不借机改需求。

### 7.1 范围清单

| 子系统 | 移植要求 |
|---|---|
| store | schema v13 平移 + 版本续排；股票/档位/参考价/时段/窗口/查询历史/通知记录/渠道配置/设置全部保留 |
| 调度 | 多时段（跨午夜、起点含终点不含）、间隔对齐、时区、每档提醒上限与继承、重叠禁止、暂停/恢复、额度耗尽停查、离线不补跑、重启保留计数 |
| 行情 | Twelve Data 客户端：匹配代码/USD/交易所校验、`last_update_at`/`last_quote_at` 年龄 -2~30 分钟、休市/日历判断、429 与额度估算、手动查询与命中选档规则（买选最低触价、卖选最高触价） |
| 日历 | NYSE 2026–2028 假日与提前收市表原样移植为数据文件（沿用已核对版本），节假日更新流程写入运维文档 |
| 通知 | Bark（HTTP/HTTPS、允许显式私网）、飞书群机器人（可选签名）、Telegram Bot；渠道各自可选代理；"任一渠道成功即占额度""全部失败不占"等计数语义不变 |
| 备份 | JSON 配置备份导出 v5 / 导入兼容 v1–5；完整库备份用 SQLite 在线快照；恢复前代理测试等行为保留 |
| Web | 服务端渲染改为 React Server Components + Server Actions；CSRF/同源防护由 Next 内建机制承担并验收；无登录策略不变 |
| 代理 | 全局代理 + 渠道级覆盖、连通性测试（展示耗时），HTTP 与 SOCKS5 |

### 7.2 明确不改

提醒规则语义、档位/收益预估口径、历史与计数、对外行为、无登录边界。

### 7.3 验收方式

- 把既有 Go 测试用例逐条翻译为 vitest/node:test 用例（调度窗口、额度、价格格式、报价年龄）；
- 新增：跨午夜时段、额度继承、渠道部分失败的计数用例；
- 真实行情/真实送达验收沿用 v1 纪律：明确测试窗口、记录预期与实际，健康检查通过 ≠ 通知送达。

## 8. 页面与路由（整合后）

| 路由 | 内容 |
|---|---|
| `/` | 门户首页（v1 §5 规格不变：搜索/分类/收藏/最近/卡片） |
| `/tools/{id}`、`/status`、`/preferences` | 沿用 |
| `/events/*`、`/config` | CDK 台账（v1 副本业务逻辑原样） |
| `/stocks/*` | TickerSentry（监控概览/详情/时段/设置/查询页） |
| `/framelab/` | Frame Lab 静态资源（相对路径不变，导航加"返回工具箱"指向 `/`） |

- 子路径适配机制（basePath/BASE_PATH/H 函数）全部删除；
- "返回工具箱"在站内就是 `/`，三个工具的头部导航统一；
- Frame Lab 保留 Canvas 行为与"照片仅在本机处理"承诺，不新增上传。

## 9. 部署与切换

### 9.1 部署物

```bash
# NAS 上仅需要：
deploy/compose.yaml        # 单服务：allinone 镜像 + /data 卷 + env
deploy/.env                # TZ / PORT / PUBLIC_ORIGIN(可选)
docker compose pull && docker compose up -d
```

env 仅剩：`TZ`、端口映射、`PUBLIC_ORIGIN`（HTTPS 反代时填）。`DATABASE_URL`、`BASE_PATH`、`PORTAL_URL`、`ALLINONE_SITE` 全部消失。

### 9.2 切换顺序（与 v1 纪律一致）

1. 镜像发布成功且本地验收通过后，才允许触碰 NAS；
2. 备份：PG dump + 旧 ticker_data 全目录 + `.env`；
3. 停旧 CDK 与旧 TickerSentry 容器（**先停再迁**，不做运行中迁移）；
4. 运行 PG→SQLite 迁移脚本 → 核对 → 复制 ticker.db → 权限（属主与容器用户一致）；
5. 启动单容器，执行 §10 验收；
6. 旧容器/旧镜像/旧数据目录保留 ≥2 周，回滚 = 停新容器 + 启动旧镜像（旧栈读原 PG 与原 ticker_data，与新数据完全隔离，回滚零数据损失）；
7. 观察期 ≥24 小时且覆盖一个真实调度窗口；期间新旧调度互斥（旧实例已停，天然满足）。

### 9.3 回滚的特殊说明

v1→v2 期间 CDK 新增数据写在 SQLite，回滚到 v1 后这些记录不在 PG 中：回滚前需把"切换后新增的台账事件"人工补录或经导出导入回 PG。为压低该成本，观察期内如需回滚应尽早执行并记录数据差异。

## 10. 验收矩阵（v2）

v1 的 A01–A05（门户 UX）、A07（台账业务）、A08–A09（TickerSentry 回归）、A10（Frame Lab）、A16（备份恢复）、A18–A20（状态/路由冲突/重启）语义保留；以下为 v2 修订：

| 编号 | 场景 | 通过标准 |
|---|---|---|
| B01 | 单镜像部署 | 仅 1 个服务 1 个容器即可完整运行；compose 中无第二镜像 |
| B02 | PG→SQLite 迁移 | 行数/抽样/聚合三核对通过；金额字段无精度损失 |
| B03 | 金额精确性 | 录入/编辑/汇总/导出的金额与 v1 结果逐分一致（无浮点误差） |
| B04 | ticker 数据沿用 | 原 ticker.db 直接可用；schema 版本 ≥13；历史/计数完整 |
| B05 | 调度等价 | 翻译用例 + 真实窗口观察：触发时间、跳市、额度、跨午夜行为与旧版一致 |
| B06 | 通知等价 | 三渠道测试 + 计数语义（部分成功占用额度）与旧版一致 |
| B07 | 备份兼容 | JSON v5 导出可被导入；v1–4 样例可导入；SQLite 快照可恢复 |
| B08 | 路由回归 | 全站无 404 死链；表单/下载/导出在无网关拓扑下直接可用 |
| B09 | 故障半径 | 容器重启后调度恢复且不补跑；计数与启用状态保留 |
| B10 | 回滚演练 | 按 §9.3 演练一次：v1 镜像可拉起、数据差异清单可产出 |
| B11 | 未来工具演练 | 以一个最小示例模块（含一条 SQLite 表 + 一张页面）验证 §5.1 约定 |

发布纪律沿用：镜像带 main/latest/sha 标签；NAS 只拉取不构建；`pull_policy: always` 沿用，回滚用 sha 标签。

## 11. 里程碑

| 阶段 | 内容 | 退出标准 |
|---|---|---|
| M-A | 单应用骨架：portal + framelab 进 `/public`、ledger 搬入（暂仍读 PG）、门户/导航整合 | 本地验收 A01–A05、A10、B08 |
| M-B | SQLite 数据层 + PG→SQLite 迁移脚本 + ledger 切换 | B02、B03 |
| M-C | TickerSentry TS 重写（store → 行情/日历 → 调度 → 通知 → 备份） | B04–B07 及翻译用例全绿 |
| M-D | 单镜像打包、NAS 切换、观察与回滚演练 | B01、B09、B10、真实窗口验收 |

M-C 期间不影响线上：v1 三镜像栈继续服务，重写全部以测试数据在本地进行。

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| TS 重写引入调度/通知回归 | 忠实移植原则 + Go 用例翻译 + 真实窗口验收；M-C 不设"顺便优化" |
| 金额精度 | TEXT 存储 + 整数分计算 + B03 专项验收 |
| 日历错漏 | 移植已核对数据文件而非重新生成；节假日变更走运维流程 |
| 单进程崩溃影响全站 | 已接受；SQLite 状态化 + `restart: unless-stopped` 自愈由 Docker 承担 |
| 整站一体发布 | 已接受；个人项目发布频率低，回滚用 sha 标签 |
| 迁移期间双写 | 纪律禁止：切换窗口内旧容器必须先停 |
| better-sqlite3 原生编译 | CI 用 node:22-bookworm 构建，NAS 为 linux/amd64+arm64 双架构发布（沿用现有 CI） |

## 13. 实施前待确认（阻塞项）

1. 无——本文档确认后即可进入 M-A。

遗留备注：旧 PostgreSQL 服务器（192.168.5.16:15432）是否还有其他用途由使用者自行决定，本项目的迁移不删除、不清空其数据。
