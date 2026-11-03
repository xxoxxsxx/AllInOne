import Link from "next/link";

import { apiKeyOf, getDB, getQuotaStatus, notificationSettings, quoteSourceOf, queryWindows, windowDuration } from "@/modules/stocks/store";
import { normalizeQuoteProvider, QUOTE_PROVIDER_LABELS } from "@/modules/stocks/quote";
import { getChannelConfig, summarizeChannels } from "@/lib/channels/center";
import { getModulePolicy } from "@/lib/channels/module-policy";
import { displayClock } from "@/modules/stocks/tz";
import { timezoneValue } from "@/modules/stocks/windows";
import {
  clearProxyAction,
  restoreConfigAction,
  saveAPIKeyAction,
  saveQuoteSourceAction,
  saveQuotaAction,
  saveProxyAction,
  saveNotificationPolicyAction,
} from "../settings-actions";
import { Flash } from "../stocks-client";

export const dynamic = "force-dynamic";

// 原版 web.go settingsPage：Title 为「行情与通知设置」。
// 渠道凭据统一到全局推送渠道中心；本页独立控制股票推送开关与渠道选择。
export const metadata = { title: "行情设置 · TickerSentry" };

// DOM 结构对应 templates/settings.html。
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const db = getDB();
  const key = apiKeyOf(db);
  const quota = getQuotaStatus(db);
  // notificationSettings 仅用于读取行情查询代理（proxy_url）；通知渠道改读全局中心。
  const c = notificationSettings(db);
  const channelsSummary = summarizeChannels(getChannelConfig());
  const policy = getModulePolicy(db, "stocks", false);
  const tz = timezoneValue(db);
  const proxyRow = db.prepare(`SELECT proxy_latency_ms,proxy_tested_at FROM settings WHERE id=1`).get() as {
    proxy_latency_ms: string;
    proxy_tested_at: string;
  };
  const counts = db
    .prepare(`SELECT (SELECT count(*) FROM stocks WHERE enabled=1) AS stocks, (SELECT count(*) FROM schedules WHERE enabled=1) AS slots`)
    .get() as { stocks: number; slots: number };
  let slots = counts.slots;
  for (const w of queryWindows(db)) {
    if (w.enabled) slots += Math.ceil(windowDuration(w) / w.interval);
  }
  const notices: Record<string, string> = {
    restored: "配置已恢复，查询和通知历史已保留；不会补跑或立即发送通知",
    saved: "配置已保存",
    cleared: "配置已清除",
    unchanged: "未填写新 Key，已保留当前配置",
    proxy_tested: "代理测试成功，响应耗时已更新",
    quota_saved: "行情额度已保存，已消耗额度不会清零",
    quote_saved: "行情源已保存",
    notification_policy_saved: "股票推送设置已保存，全局渠道配置未修改",
  };
  const quotaDaily = counts.stocks * slots;
  const source = quoteSourceOf(db);
  const provider = normalizeQuoteProvider(source.provider);
  const finnhubKey = source.finnhubKey;

  return (
    <div className="settings-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">PREFERENCES</span>
          <h1>服务设置</h1>
          <p>管理行情来源、股票自动推送、网络代理和配置备份。渠道凭据在全局推送渠道页统一配置。</p>
        </div>
      </div>
      <Flash text={sp.error ?? notices[sp.result ?? ""] ?? ""} />
      <div className="settings-index" aria-label="设置分区">
        <a href="#market-title">行情来源</a>
        <a href="#proxy-title">网络代理</a>
        <a href="#channels-link-title">股票推送</a>
        <a href="#backup-title">配置备份</a>
      </div>

      <section className="settings-group" aria-labelledby="market-title">
        <div className="settings-group-head">
          <div>
            <span className="eyebrow">01 / MARKET DATA</span>
            <h2 id="market-title">行情来源</h2>
          </div>
          <p>选择行情源并配置对应的 API Key</p>
        </div>
        <div className="settings-panel">
          <div className="settings-intro">
            <div className="settings-name">
              <h3>当前行情源</h3>
              <span className="status-pill">{QUOTE_PROVIDER_LABELS[provider]}</span>
            </div>
            <p>免费档额度：Twelve Data 8 次/分钟、800 次/天；Finnhub 60 次/分钟。监控股票较多或查询较密时建议选 Finnhub。</p>
          </div>
          <div className="settings-content">
            <form action={saveQuoteSourceAction}>
              <label>
                行情源
                <select name="quote_provider" defaultValue={provider}>
                  <option value="twelvedata">Twelve Data（8 次/分钟、800 次/天）</option>
                  <option value="finnhub">Finnhub（60 次/分钟、美股实时）</option>
                </select>
              </label>
              <div className="settings-actions">
                <button className="primary" type="submit">
                  保存行情源
                </button>
              </div>
            </form>
          </div>
        </div>
        <div className="settings-panel">
          <div className="settings-intro">
            <div className="settings-name">
              <h3>Twelve Data API Key</h3>
              {provider === "twelvedata" ? <span className="status-pill">使用中</span> : key ? <span className="status-pill is-off">已配置</span> : <span className="status-pill is-off">未配置</span>}
            </div>
            <p>
              当前支持美股（USD）。可使用
              <a href="https://twelvedata.com/pricing" target="_blank" rel="noopener noreferrer">
                免费套餐申请 Key ↗
              </a>
              。
            </p>
          </div>
          <div className="settings-content">
            <form action={saveAPIKeyAction}>
              <label>
                Twelve Data API Key
                <input
                  type="text"
                  name="api_key"
                  defaultValue={key}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={256}
                  required={!key}
                />
              </label>
              <div className="settings-actions">
                <button className="primary" type="submit">
                  保存 Key
                </button>
              </div>
            </form>
            {key ? (
              <form action={saveAPIKeyAction} className="settings-clear" data-confirm="清除行情 Key 后，使用 Twelve Data 时将无法查询行情，确定清除？">
                <input type="hidden" name="clear" value="1" />
                <button type="submit">清除 Key</button>
              </form>
            ) : null}
          </div>
        </div>
        <div className="settings-panel">
          <div className="settings-intro">
            <div className="settings-name">
              <h3>Finnhub API Key</h3>
              {provider === "finnhub" ? <span className="status-pill">使用中</span> : finnhubKey ? <span className="status-pill is-off">已配置</span> : <span className="status-pill is-off">未配置</span>}
            </div>
            <p>
              免费档 60 次/分钟、美股实时，仅支持美股（USD）。可在
              <a href="https://finnhub.io/register" target="_blank" rel="noopener noreferrer">
                finnhub.io 免费注册 ↗
              </a>
              后获取 Key。
            </p>
          </div>
          <div className="settings-content">
            <form action={saveQuoteSourceAction}>
              <input type="hidden" name="quote_provider" value={provider} />
              <label>
                Finnhub API Key
                <input
                  type="text"
                  name="finnhub_key"
                  defaultValue={finnhubKey}
                  placeholder="finnhub_free_key"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={256}
                />
              </label>
              <div className="settings-actions">
                <button className="primary" type="submit">
                  保存 Finnhub Key
                </button>
              </div>
            </form>
            <p className="settings-footnote">Finnhub 的 Key 随请求 URL 提交（官方鉴权方式），本应用不落地到日志。切换行情源不会影响额度统计与查询时段。</p>
          </div>
        </div>
        <div className="settings-panel">
          <div className="settings-intro">
            <div className="settings-name"><h3>查询额度与分批</h3></div>
            <p>自动和手动查询共享额度。达到分钟上限后等待恢复，再继续本轮，不会直接跳过后面的股票。</p>
          </div>
          <div className="settings-content">
            <div className="quota-summary" aria-label="行情额度用量">
              <span>过去 24 小时已用 <strong>{quota.dayUsed} / {quota.dayLimit}</strong></span>
              <span>当前分钟剩余 <strong>{Math.max(0, quota.minuteLimit - quota.minuteUsed)} / {quota.minuteLimit}</strong></span>
            </div>
            {quota.retryAfterMs > 0 ? <p className="info-strip">额度或服务端限流等待中，约 {Math.ceil(quota.retryAfterMs / 1000)} 秒后重新检查。</p> : null}
            <form action={saveQuotaAction}>
              <div className="quota-fields">
                <label>每分钟额度<input name="quota_per_minute" type="number" min="1" max="100000" step="1" required defaultValue={quota.minuteLimit} /></label>
                <label>24 小时额度<input name="quota_per_day" type="number" min="1" max="100000000" step="1" required defaultValue={quota.dayLimit} /></label>
              </div>
              <div className="settings-actions"><button className="primary" type="submit">保存额度</button></div>
            </form>
            <p className="settings-footnote">切换行情源后请同步调整额度：Twelve Data 免费档约 8 次/分钟、800 次/天；Finnhub 免费档约 60 次/分钟（建议设 50 留余量）。本应用保守使用滚动 61 秒与滚动 24 小时计数，重启保留；统计不含其他程序对同一 Key 的请求。此处用量为页面打开时的快照。</p>
          </div>
        </div>
        <p className="settings-footnote">
          每轮约 {counts.stocks} 次请求；按已启用的固定时间点和查询时段估算每天最多约 {quotaDaily}{" "}
          次。休市、重复时间点及达到上限后停止的查询未计入；手动查询、429 重试和其他客户端用量另计。
        </p>
        {quotaDaily >= quota.dayLimit ? (
          <p className="info-strip">预计用量已达到所设的 {quota.dayLimit} 次 / 24 小时查询预算，建议延长查询间隔或减少启用的股票，或切换到 Finnhub。</p>
        ) : null}
      </section>

      <section className="settings-group" aria-labelledby="proxy-title">
        <div className="settings-group-head">
          <div>
            <span className="eyebrow">02 / NETWORK</span>
            <h2 id="proxy-title">网络代理</h2>
          </div>
          <p>仅用于行情查询；推送渠道的代理在全局推送渠道页按渠道单独设置。</p>
        </div>
        <div className="settings-panel">
          <div className="settings-intro">
            <div className="settings-name">
              <h3>OpenClash / 软路由</h3>
              {c.Proxy ? <span className="status-pill">已配置</span> : <span className="status-pill is-off">直连</span>}
            </div>
            <p>
              使用软路由的 HTTP 或 SOCKS5 代理端口。容器内 127.0.0.1
              指向容器自身；请填写软路由局域网地址，并允许局域网连接。
            </p>
          </div>
          <div className="settings-content">
            <form action={saveProxyAction}>
              <input type="hidden" name="proxy_save" value="1" />
              <label>
                代理地址和端口
                <input
                  type="text"
                  name="proxy_url"
                  defaultValue={c.Proxy}
                  placeholder="192.168.5.1:7890 或 socks5://192.168.5.1:7891"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={256}
                  required
                />
              </label>
              <div className="settings-actions">
                <button className="primary" type="submit">
                  测试并保存
                </button>
              </div>
            </form>
            {c.Proxy ? (
              <>
                {proxyRow.proxy_latency_ms ? (
                  <p className="proxy-result">
                    Telegram 响应耗时：<strong>{proxyRow.proxy_latency_ms} ms</strong>
                    <br />
                    <span>
                      {displayClock(proxyRow.proxy_tested_at ? new Date(proxyRow.proxy_tested_at) : null, tz)} ·
                      经代理完成一次 HTTPS 请求，数值越低通常响应越快
                    </span>
                  </p>
                ) : (
                  <p className="proxy-result">尚未测试，请重新测试代理。</p>
                )}
                <div className="settings-secondary">
                  <form action={saveProxyAction}>
                    <input type="hidden" name="proxy_test" value="1" />
                    <button type="submit">重新测试</button>
                  </form>
                  <form action={clearProxyAction} data-confirm="清除代理后行情查询将直连，确定清除？">
                    <button type="submit">清除代理</button>
                  </form>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="channels-link-title">
        <div className="settings-group-head">
          <div>
            <span className="eyebrow">03 / NOTIFICATIONS</span>
            <h2 id="channels-link-title">股票推送</h2>
          </div>
          <p>自动推送默认关闭；开启后向本模块勾选且全局启用的渠道发送。</p>
        </div>
        <div className="settings-panel">
          <div className="settings-intro">
            <div className="settings-name">
              <h3>统一配置于全局推送渠道</h3>
              {channelsSummary.bark.configured || channelsSummary.feishu.configured || channelsSummary.telegram.configured ? (
                <span className="status-pill">已配置</span>
              ) : (
                <span className="status-pill is-off">未配置</span>
              )}
            </div>
            <p>
              Bark / 飞书 / Telegram 与代理在<Link href="/channels">全局推送渠道</Link>页统一配置，
              证件夹到期提醒与提醒事项共用同一份。下方设置仅影响股票推送，不修改全局渠道或其他业务设置。
            </p>
          </div>
          <div className="settings-content">
            <form action={saveNotificationPolicyAction}>
              <label className="settings-option">
                <input type="checkbox" name="enabled" defaultChecked={policy.enabled} />
                开启自动推送
              </label>
              <p className="settings-footnote">关闭后仍可查询行情，但不发送触价提醒、不占用档位提醒额度。每个档位每次命中只计一次提醒。</p>
              <fieldset>
                <legend>股票推送渠道</legend>
                <label className="settings-option"><input type="checkbox" name="bark" defaultChecked={policy.bark} />Bark（全局{channelsSummary.bark.enabled ? "已启用" : "未启用"}）</label>
                <label className="settings-option"><input type="checkbox" name="feishu" defaultChecked={policy.feishu} />飞书（全局{channelsSummary.feishu.enabled ? "已启用" : "未启用"}）</label>
                <label className="settings-option"><input type="checkbox" name="telegram" defaultChecked={policy.telegram} />Telegram（全局{channelsSummary.telegram.enabled ? "已启用" : "未启用"}）</label>
              </fieldset>
              <p className="settings-footnote">只有本页勾选且全局启用并配置好的渠道会发送；未选择渠道时不发送通知。</p>
              <div className="settings-actions"><button className="primary" type="submit">保存股票推送设置</button></div>
            </form>
            <div className="quota-summary" aria-label="渠道状态">
              <span>Bark {channelsSummary.bark.configured ? `已配置（${channelsSummary.bark.host}）` : "未配置"}</span>
              <span>飞书 {channelsSummary.feishu.configured ? "已配置" : "未配置"}</span>
              <span>Telegram {channelsSummary.telegram.configured ? "已配置" : "未配置"}</span>
              <span>代理 {channelsSummary.proxy.configured ? "已配置" : "未配置"}</span>
            </div>
            <div className="settings-actions">
              <Link className="primary" href="/channels">前往全局推送渠道 →</Link>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="backup-title">
        <div className="settings-group-head">
          <div>
            <span className="eyebrow">04 / BACKUP</span>
            <h2 id="backup-title">配置备份与恢复</h2>
          </div>
        </div>
        <div className="settings-panel">
          <div className="settings-intro">
            <h3>保存当前配置</h3>
            <p>备份包含股票、目标价、提醒上限、查询安排、代理地址及各通知渠道的代理选择。文件含密钥，请妥善保存。</p>
          </div>
          <div className="settings-content">
            <form action="/stocks/settings/backup" method="post">
              <button type="submit">下载配置备份</button>
            </form>
            <details className="settings-restore">
              <summary>从备份恢复配置</summary>
              <p>
                JSON 备份不包含查询和通知历史。恢复会覆盖当前配置并创建新档位；历史保留，旧档位次数不沿用，也不会补跑任务。完整数据请使用
                SQLite 备份。
              </p>
              <form
                action={restoreConfigAction}
                data-confirm="确定使用这个备份覆盖全部股票、提醒价格、查询时间和服务配置？建议先下载当前配置备份。"
              >
                <label>
                  选择配置备份（JSON，最大 2 MiB）
                  <input type="file" name="backup" accept=".json,application/json" required />
                </label>
                <label className="settings-option">
                  <input type="checkbox" name="confirm" value="restore" required />
                  确认覆盖当前配置，并导入备份中的密钥和提醒状态
                </label>
                <button type="submit">恢复配置</button>
              </form>
            </details>
          </div>
        </div>
      </section>
    </div>
  );
}
