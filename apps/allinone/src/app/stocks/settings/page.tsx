import { getDB, notificationSettings, defaultAlerts, apiKeyOf, queryWindows, windowText, overnight, windowDuration } from "@/modules/stocks/store";
import { displayClock } from "@/modules/stocks/tz";
import {
  saveAPIKeyAction,
  saveProxyAction,
  clearProxyAction,
  saveBarkAction,
  clearBarkAction,
  saveFeishuAction,
  clearFeishuAction,
  saveTGAction,
  clearTGAction,
  testBarkAction,
  testFeishuAction,
  testTGAction,
  restoreConfigAction,
} from "../settings-actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "行情与通知设置 · TickerSentry" };

function Notice({ text }: { text: string }) {
  if (!text) return null;
  return <p className="info-strip" role="status">{text}</p>;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string; tested?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const db = getDB();
  const key = apiKeyOf(db);
  const c = notificationSettings(db);
  const proxyRow = db.prepare(`SELECT proxy_latency_ms,proxy_tested_at,timezone FROM settings WHERE id=1`).get() as { proxy_latency_ms: string; proxy_tested_at: string; timezone: string };
  const counts = db.prepare(`SELECT (SELECT count(*) FROM stocks WHERE enabled=1) AS stocks, (SELECT count(*) FROM schedules WHERE enabled=1) AS slots`).get() as { stocks: number; slots: number };
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
  };
  const testedMap: Record<string, string> = { bark: "Bark", feishu: "飞书", telegram: "Telegram" };
  const quotaDaily = counts.stocks * slots;

  return (
    <div className="settings-page">
      <div className="page-head">
        <div><h1>服务设置</h1><p>管理行情来源、通知渠道和配置备份。</p></div>
      </div>
      <Notice text={sp.error ?? notices[sp.result ?? ""] ?? ""} />
      {sp.tested ? <Notice text={`${testedMap[sp.tested] ?? ""} 已接受测试通知；请在接收端核对送达`} /> : null}

      <section className="settings-group">
        <h2 id="market-title">行情来源</h2>
        <div className="settings-panel">
          <div className="settings-intro">
            <h3>Twelve Data {key ? "已配置" : "未配置"}</h3>
            <p>当前支持 Twelve Data。可使用免费套餐申请 Key；免 Key 行情源仍在核验。</p>
          </div>
          <form action={saveAPIKeyAction}>
            <label>Twelve Data API Key<input type="text" name="api_key" defaultValue={key} autoComplete="off" maxLength={256} required={!key} /></label>
            <button type="submit">保存 Key</button>
          </form>
          {key ? (
            <form action={saveAPIKeyAction}>
              <input type="hidden" name="clear" value="1" />
              <button type="submit">清除 Key</button>
            </form>
          ) : null}
          <p className="settings-footnote">每轮约 {counts.stocks} 次请求；按已启用的固定时间点和查询时段估算每天最多约 {quotaDaily} 次。休市、重复时间点及达到上限后停止的查询未计入；手动查询、429 重试和其他客户端用量另计。</p>
          {quotaDaily >= 800 ? <p className="info-strip">预计用量已达到本程序 800 次 / 24 小时的查询预算，建议延长查询间隔或减少启用的股票。</p> : null}
        </div>
      </section>

      <section className="settings-group">
        <h2 id="proxy-title">网络代理</h2>
        <div className="settings-panel">
          <div className="settings-intro">
            <h3>OpenClash / 软路由 {c.Proxy ? "已配置" : "直连"}</h3>
            <p>使用软路由的 HTTP 或 SOCKS5 代理端口。容器内 127.0.0.1 指向容器自身；请填写软路由局域网地址，并允许局域网连接。</p>
          </div>
          <form action={saveProxyAction}>
            <input type="hidden" name="proxy_save" value="1" />
            <label>代理地址和端口<input type="text" name="proxy_url" defaultValue={c.Proxy} placeholder="192.168.5.1:7890 或 socks5://192.168.5.1:7891" autoComplete="off" maxLength={256} required /></label>
            <button type="submit">测试并保存</button>
          </form>
          {c.Proxy ? (
            <>
              {proxyRow.proxy_latency_ms ? (
                <p className="proxy-result">Telegram 响应耗时：<strong>{proxyRow.proxy_latency_ms} ms</strong><br />
                  <span>{displayClock(new Date(proxyRow.proxy_tested_at), proxyRow.timezone)} · 经代理完成一次 HTTPS 请求，数值越低通常响应越快</span></p>
              ) : <p className="proxy-result">尚未测试，请重新测试代理。</p>}
              <div className="settings-secondary">
                <form action={saveProxyAction}><input type="hidden" name="proxy_test" value="1" /><button type="submit">重新测试</button></form>
                <form action={clearProxyAction}><button type="submit">清除代理</button></form>
              </div>
            </>
          ) : null}
        </div>
      </section>

      <section className="settings-group">
        <h2 id="channels-title">通知渠道</h2>
        <p>触价后向所有启用渠道发送；每个档位每次命中只计一次提醒。</p>

        <div className="settings-panel">
          <h3>Bark {c.BarkEnabled ? "已启用" : c.Bark.Key ? "已停用" : "未配置"}</h3>
          <form action={saveBarkAction}>
            <label>服务根地址<input type="url" name="bark_url" defaultValue={c.Bark.URL} placeholder="https://api.day.app" required /></label>
            <label>Bark 设备 Key<input type="text" name="bark_key" defaultValue={c.Bark.Key} autoComplete="off" maxLength={256} /></label>
            <label className="settings-option"><input type="checkbox" name="allow_local" value="1" defaultChecked={c.Bark.Local} />允许可信内网地址或 HTTP</label>
            <label className="settings-option"><input type="checkbox" name="use_proxy" value="1" defaultChecked={c.BarkProxy} disabled={!c.Proxy} />通过代理发送{!c.Proxy ? "（请先配置代理）" : ""}</label>
            <label className="settings-toggle"><input type="checkbox" name="enabled" value="1" defaultChecked={c.BarkEnabled} />启用 Bark 通知</label>
            <button type="submit">保存 Bark</button>
          </form>
          {c.Bark.Key ? (
            <div className="settings-secondary">
              <form action={testBarkAction}><button type="submit">测试 Bark</button></form>
              <form action={clearBarkAction}><button type="submit">清除配置</button></form>
            </div>
          ) : null}
        </div>

        <div className="settings-panel">
          <h3>飞书群机器人 {c.FeishuEnabled ? "已启用" : c.FeishuWebhook ? "已停用" : "未配置"}</h3>
          <form action={saveFeishuAction}>
            <label>Webhook 地址<input type="url" name="feishu_webhook" defaultValue={c.FeishuWebhook} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." autoComplete="off" required /></label>
            <label>签名密钥（可选）<input type="text" name="feishu_secret" defaultValue={c.FeishuSecret} autoComplete="off" maxLength={256} /></label>
            <label className="settings-option"><input type="checkbox" name="use_proxy" value="1" defaultChecked={c.FeishuProxy} disabled={!c.Proxy} />通过代理发送{!c.Proxy ? "（请先配置代理）" : ""}</label>
            <label className="settings-toggle"><input type="checkbox" name="enabled" value="1" defaultChecked={c.FeishuEnabled} />启用飞书通知</label>
            <button type="submit">保存飞书</button>
          </form>
          {c.FeishuWebhook ? (
            <div className="settings-secondary">
              <form action={testFeishuAction}><button type="submit">测试飞书</button></form>
              <form action={clearFeishuAction}><button type="submit">清除配置</button></form>
            </div>
          ) : null}
        </div>

        <div className="settings-panel">
          <h3>Telegram Bot {c.TGEnabled ? "已启用" : c.TGToken ? "已停用" : "未配置"}</h3>
          <form action={saveTGAction}>
            <label>Bot Token<input type="text" name="tg_token" defaultValue={c.TGToken} autoComplete="off" required /></label>
            <label>数字 Chat ID<input type="text" name="tg_chat_id" defaultValue={c.TGChatID} autoComplete="off" inputMode="numeric" required /></label>
            <label className="settings-option"><input type="checkbox" name="use_proxy" value="1" defaultChecked={c.TGProxy} disabled={!c.Proxy} />通过代理发送{!c.Proxy ? "（请先配置代理）" : ""}</label>
            <label className="settings-toggle"><input type="checkbox" name="enabled" value="1" defaultChecked={c.TGEnabled} />启用 Telegram 通知</label>
            <button type="submit">保存 Telegram</button>
          </form>
          {c.TGToken ? (
            <div className="settings-secondary">
              <form action={testTGAction}><button type="submit">测试 Telegram</button></form>
              <form action={clearTGAction}><button type="submit">清除配置</button></form>
            </div>
          ) : null}
        </div>
        <p className="settings-footnote">测试通知只确认服务接受请求，请在接收端核对是否送达。</p>
      </section>

      <section className="settings-group">
        <h2 id="backup-title">配置备份与恢复</h2>
        <div className="settings-panel">
          <div className="settings-intro"><h3>保存当前配置</h3><p>备份包含股票、目标价、提醒上限、查询安排、代理地址及各通知渠道的代理选择。文件含密钥，请妥善保存。</p></div>
          <form action="/stocks/settings/backup" method="post">
            <button type="submit">下载配置备份</button>
          </form>
          <details className="settings-restore">
            <summary>从备份恢复配置</summary>
            <p>JSON 备份不包含查询和通知历史。恢复会覆盖当前配置并创建新档位；历史保留，旧档位次数不沿用，也不会补跑任务。完整数据请使用 SQLite 备份。</p>
            <form action={restoreConfigAction}>
              <label>选择配置备份（JSON，最大 2 MiB）<input type="file" name="backup" accept=".json,application/json" required /></label>
              <label className="settings-option"><input type="checkbox" name="confirm" value="restore" required />确认覆盖当前配置，并导入备份中的密钥和提醒状态</label>
              <button type="submit">恢复配置</button>
            </form>
          </details>
        </div>
      </section>

      <p className="muted small">窗口时段：{queryWindows(db).map((w) => `${windowText(w.start)}～${overnight(w) ? "次日 " : ""}${windowText(w.end)}（每 ${w.interval} 分钟）`).join("、") || "未配置"}</p>
      <p className="muted small">默认提醒上限：{defaultAlerts(db)} 次 / 档。</p>
    </div>
  );
}
