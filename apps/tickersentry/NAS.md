# NAS 部署与备份（带 Twelve Data Key 的预览版）

本版本尚未通过正式行情与 NAS 实机验收，不是免 Key 完整版。NYSE 2026–2028 年已公布假日和提前收市已与所用日历版本核对，程序也会在该窗口外停止自动查询与触价。部署者应在常规交易时段核对 `close` 与 `last_update_at` / `last_quote_at` 的语义，并用 Bark 设备确认推送送达。设置提醒价和自动查询时间后，有效报价命中即尝试推送；交易所临时停市需要人工禁用时间表。

## 本地构建和安装

需 Docker Engine + Compose。先检查 NAS 架构（`uname -m`），执行 `docker compose build` 和 `docker compose up -d`；`docker compose ps` 查看健康状态。无需账号密码，打开首页即可使用。旧 Compose 的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 可以删除。默认仅绑定主机 `127.0.0.1:8080`，浏览器在 NAS 本机打开 `http://127.0.0.1:8080/`。应用不设登录限制，能访问端口的人即可查看配置并操作；仅用于可信网络。容器以 UID 65532、只读根文件系统运行，`/data` 必须是可由该 UID 写入的本地卷或宿主机目录。

若 HTTPS 在反向代理处终止，给应用设置 `PUBLIC_ORIGIN=https://你的域名`；其值必须是浏览器看到的来源地址，不带路径。反向代理只向应用转发可信请求，应用会用该值检查表单来源。

首次打开后在设置页填写 Twelve Data Key、Bark 地址和设备 Key，再添加股票与档位。时间表在「自动查询」页设置，默认时区 `Asia/Shanghai`。免费套餐 `/quote` 每股票约 1 credit；代码按每滚动分钟 8 次、每 24 小时 800 次保守控制，10 股至少跨两个分钟窗口；手动查询和重试共享额度。供应商账户上的其他客户端消耗额度不在本地计数内，429 或超时会逐股显示。行情和 Bark 密钥只保存在本地卷，限制 NAS 管理员及备份访问，勿复制到 Compose、镜像、Git 或日志。Bark 可能重复送达，不能用于自动交易。

多架构构建（需要可用的 Docker daemon 和 buildx）：

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t tickersentry:local .
```

这只验证构建，不代表 NAS 实机运行。`.github/workflows/container.yml` 在 `main` 或 `v*` 标签推送时自动构建 amd64/arm64 镜像并发布到 GHCR；也可手动触发。与 `cdk-ledger-app` 一样，生成 `main`、`latest`、短 SHA 和版本标签。推送后在 GitHub Actions 中确认构建结果，再按下文从 NAS 拉取镜像。

## 从 GHCR 部署

镜像地址是 `ghcr.io/xxoxxsxx/tickersentry:<标签>`。NAS 使用 [compose.ghcr.yaml](compose.ghcr.yaml)，固定拉取 `:main`。如需固定版本或 SHA 标签以便回滚，直接修改该文件的 `image` 字段。

如果 GHCR 包是私有的，NAS 先执行 `docker login ghcr.io -u <GitHub 用户名>`，密码使用具备 `read:packages` 权限的 GitHub PAT。首次部署或升级时执行：

```sh
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
docker compose -f compose.ghcr.yaml ps
```

NAS 不会因 GitHub 推送自动更新容器；以上拉取与启动步骤仍需在 NAS 执行。首次初始化和数据卷说明与本页前文相同，升级前先做在线备份。

## 备份与恢复

设置页可下载 JSON 配置备份并上传恢复（最大 2 MiB）。包含密钥、股票、价格档位及提醒状态、查询时间和时区；恢复覆盖配置但保留当前历史，查询进行中不能恢复。建议恢复前先下载当前配置。JSON 不含查询和通知历史，完整历史使用下方 SQLite 备份。

在线备份使用 SQLite `VACUUM INTO`，能包含 WAL 中已提交数据。可在服务运行时执行（目标文件必须不存在）：

```sh
docker compose -f compose.ghcr.yaml exec -u 65532 tickersentry /app -data /data -backup /data/backups/backup-20261009.db
```

使用本地构建版时将 `-f compose.ghcr.yaml` 改为 `-f compose.yaml`。输出默认仅 UID 65532 可读；通过受限管理员环境把备份复制到 NAS 上受保护的存储，建议离线加密并做恢复演练。不能只复制活动中的 `ticker.db` 而忽略 WAL。恢复须 **先停机**，备份原数据卷，在同一卷里将已验证的备份替换 `ticker.db` 并移除旧 `ticker.db-wal` / `ticker.db-shm`，保持 UID 65532 所有权和 0600 文件权限，再启动与数据库版本相匹配的镜像。跨数据库迁移回滚时，必须同时恢复升级前镜像和升级前数据库备份。请勿在运行中直接覆盖活动数据库。

## 排障

`/healthz` 探测数据库可用性；页面上的逐股错误、任务部分完成/跳过原因比容器日志更适合定位限流、休市、时间字段、币种及通知问题。未配置 Key 会跳过自动查询。自动和手动查询均会在有效报价命中档位时尝试推送；请检查任务结果和通知记录定位失败。请勿将敏感响应、账号密码和 Key 贴到公开工单。服务不可达先检查 `docker compose ps`、目录写权限、端口绑定和代理。不要把应用直接公开到互联网。
