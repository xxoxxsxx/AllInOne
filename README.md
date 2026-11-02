<div align="center">

# 🧰 AllInOne

**一个镜像，装下你的整个工具间。**

个人自托管工具箱 · Next.js 16 单应用 · SQLite 单文件 · 数据始终在你手里

[![CI](https://github.com/xxoxxsxx/AllInOne/actions/workflows/ci.yml/badge.svg)](https://github.com/xxoxxsxx/AllInOne/actions/workflows/ci.yml)
[![Release](https://github.com/xxoxxsxx/AllInOne/actions/workflows/release.yml/badge.svg)](https://github.com/xxoxxsxx/AllInOne/actions/workflows/release.yml)
![Image](https://img.shields.io/badge/image-ghcr.io%2Fxxoxxsxx%2Fallinone-2496ed)
![Next.js](https://img.shields.io/badge/Next.js-16-black)
![React](https://img.shields.io/badge/React-19-61dafb)
![Node](https://img.shields.io/badge/Node-22 LTS-339933)

[快速开始](#-快速开始) · [工具一览](#-工具一览) · [亮点](#-为什么值得用) · [开发](#-开发)

</div>

---

## 📖 这是什么

AllInOne 是一套**跑在自己 NAS 上的个人工具网站**：门户、业务台账、行情提醒、旅行规划、证件管理，以及一批纯本地运行的影像小工具，全部住进**同一个 Next.js 应用、同一个 Docker 容器、同一个 SQLite 文件**。

它前身是三个独立服务、三份镜像、一套网关路由——子路径转发曾是所有诡异 bug 的来源。v2 推倒重来：**一个镜像发布，以后加工具只用一种技术栈**，网关、basePath、外部数据库全部消失。

> 拉镜像、起容器、打开浏览器，你的工具间就开张了。

## 🧭 工具一览

| 工具 | 入口 | 一句话介绍 |
|---|---|---|
| 🧭 **门户** | `/` | 工具卡片墙 · 全局搜索 · 收藏与最近使用 · 状态页 |
| 🗂 **CDK 台账** | `/ledger` | CDK 发货、代发、作废与换新，每一笔都有账可查 |
| 📈 **股票提醒** | `/stocks` | 档位触价监控，Bark / 飞书 / Telegram 多渠道推送，支持 HTTP 与 SOCKS5 代理 |
| 🗺 **旅行攻略** | `/travel` | 按天安排地点、地图标注、照片与各平台攻略链接一页收齐 |
| 🪪 **证件夹** | `/documents` | 证件与签证有效期、分类标签、扫描件附件、到期自动提醒、一键备份 |
| 📷 **Frame Lab** | `/framelab` | 给照片套上相机边框，屏幕与取景双视角，多条水印自由排版 |
| 🖼 **摄影拼图** | `/collage` | 多图构图、独立裁切、留白排版，浏览器本地导出高清拼图 |
| 🔳 **二维码** | `/qrlab` | 文字生成二维码；拖入 / 粘贴图片即可识别，全程不联网 |

## ✨ 为什么值得用

- **📦 一个镜像交付** — `docker compose pull` 即完成升级；`linux/amd64` + `arm64` 双架构，x86 主机与 Apple Silicon / ARM 盒子通吃。
- **🎨 媒体工具纯本地** — Frame Lab、摄影拼图、二维码的照片处理全部发生在你的浏览器里，**没有上传请求**，隐私不是承诺而是架构。
- **💾 备份 = 复制一个目录** — 所有状态（含调度进度）都在 `/data` 卷的 SQLite（WAL 模式）里，没有外部数据库依赖。
- **⏰ 应用内调度** — 行情轮询与到期提醒随进程启动注册，重启后行为可预期：断线期间不补跑、不轰炸。
- **💰 金额绝不用浮点** — 台账金额全程十进制字符串 + 整数分计算，账目分毫不差。
- **🧪 测试护城** — 230+ 纯 Node 单元测试覆盖台账、行情调度、证件备份与工具模块，`pnpm test` 秒级跑完。
- **🔌 加工具像加卡片** — 新建 `src/app/<id>/`（或纯静态 `public/<id>/`），在 `config/tools.json` 登记一行，门户自动收录。

## 🚀 快速开始

```bash
git clone https://github.com/xxoxxsxx/AllInOne.git
cd AllInOne/deploy
cp .env.example .env    # 按注释填写
docker compose pull && docker compose up -d
```

打开 `http://<你的主机IP>:36889` 即可使用。镜像也可以直接拉取：

```bash
docker pull ghcr.io/xxoxxsxx/allinone:main
```

数据保存在 `/data` 卷（SQLite），健康检查内置 `GET /api/health`。推送到 `main` 后，Actions 会自动构建并发布新镜像，NAS 上 `compose pull` 一下就完成更新。

## 🏗 架构一览

```text
ghcr.io/xxoxxsxx/allinone        ← 唯一镜像
└── Next.js 16 单应用（长驻 Node 22 进程）
    ├── /            门户
    ├── /ledger      CDK 台账
    ├── /stocks      TickerSentry（应用内调度器）
    ├── /travel      旅行攻略
    ├── /documents   证件夹
    └── /framelab /collage /qrlab   纯本地静态工具
         │
/data   ┴── SQLite × N + 附件，备份整个目录即可
```

技术栈：TypeScript · Next.js 16 (App Router) · React 19 · Tailwind · better-sqlite3 · pnpm

## 🛠 开发

```bash
cd apps/allinone
pnpm install
pnpm dev        # http://localhost:3000
pnpm test       # node --test 单元测试
pnpm build      # 类型检查 + 构建
```

### 添加新工具

1. 服务型：新建 `src/app/<id>/`；纯前端型：新建 `public/<id>/`（保持相对路径，可独立部署）。
2. 在 `apps/allinone/config/tools.json` 登记名称、入口、分类与图标。
3. 完事——门户的卡片墙、搜索、状态页会自动带上它。

约定与验收标准的完整版见 [PRD.md](PRD.md)，各模块说明见 [docs/](docs/)。

---

<div align="center">

**把工具间搬回自己家里，从一条 `compose pull` 开始。**

</div>
