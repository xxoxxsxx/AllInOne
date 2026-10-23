import Link from "next/link";

import { getDB, listStocks, listRuns, schedules, queryWindows, windowDuration, targetGap, setReturns } from "@/modules/stocks/store";
import { levelUsage, windowUsageAll, activeWindow, timezoneValue } from "@/modules/stocks/windows";
import { nextWindowOccurrence } from "@/modules/stocks/next-fire";
import { quoteReadiness } from "@/modules/stocks/readiness";
import { nextFireForSchedule } from "@/modules/stocks/next-fire";
import { displayClock } from "@/modules/stocks/tz";
import { statusText } from "./display";
import { startRunAction, stockAddAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "监控概览 · TickerSentry" };

function Flash({ text }: { text: string }) {
  if (!text) return null;
  return <p className="info-strip" role="status">{text}</p>;
}

export default async function StocksHomePage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const db = getDB();
  const tz = timezoneValue(db);
  const nowD = new Date();
  const stocks = listStocks(db);
  for (const s of stocks) {
    const { levels, window } = levelUsage(db, s.ID, s.Symbol, nowD, tz);
    for (const l of levels) {
      l.Gap = targetGap(l.Side, l.Target, s.LastPrice);
      if (l.Side === "buy") s.BuyLevels.push(l);
      else s.SellLevels.push(l);
    }
    setReturns(s);
    s.AlertReason = quoteReadiness(s, nowD);
    const levelsAll = [...s.BuyLevels, ...s.SellLevels];
    if (window) {
      let active = 0;
      let exhausted = 0;
      for (const l of levelsAll) {
        if (l.Enabled) {
          active++;
          if (l.Used >= l.Limit) exhausted++;
        }
      }
      const status = `本时段档位额度：${exhausted}/${active} 个已用尽`;
      if (active > 0 && exhausted === active) {
        s.WindowStatus = status + " · 本时段自动查询已停止";
        s.WindowCapped = true;
      } else if (!window.enabled) {
        s.WindowStatus = status + " · 时段查询已暂停";
      } else {
        s.WindowStatus = status;
      }
    }
  }
  const activeStocks = stocks.filter((s) => s.Enabled).length;
  const keySet = (db.prepare(`SELECT api_key FROM settings WHERE id=1`).get() as { api_key: string }).api_key !== "";
  const runs = listRuns(db);
  const scheds = schedules(db);
  let next: Date | null = null;
  for (const s of scheds) {
    if (!s.enabled) continue;
    const t = nextFireForSchedule(s.hour, s.minute, tz, nowD);
    if (t && (!next || t < next)) next = t;
  }
  for (const w of queryWindows(db)) {
    if (!w.enabled) continue;
    const t = nextWindowOccurrence(w, tz, nowD);
    if (t && (!next || t < next)) next = t;
  }
  const active = activeWindow(db, nowD, tz);
  const usage = active ? windowUsageAll(db, active.window, active.day) : new Map<string, Map<string, number>>();
  // 覆盖首页档位用量（与 Go home() 一致：activeWindow 驱动 Used/Limit 展示）。
  if (active) {
    for (const s of stocks) {
      for (const group of [s.BuyLevels, s.SellLevels]) {
        for (const l of group) {
          l.Used = usage.get(s.Symbol)?.get(l.UID) ?? 0;
          l.Limit = l.MaxAlerts > 0 ? l.MaxAlerts : active.window.max_alerts;
          l.WindowActive = true;
        }
      }
    }
  }
  const { readiness } = await import("@/modules/stocks/readiness");
  const { notificationSettings } = await import("@/modules/stocks/store");
  const items = readiness(notificationSettings(db), keySet, next !== null, nowD);
  const flashMap: Record<string, string> = {
    stock_added: "股票已添加，可在下方设置提醒价格。",
    stock_saved: "股票设置已保存。",
    stock_deleted: "股票已删除，相关提醒价格一并移除。",
    reference_saved: "收益参考买入价已保存。",
  };

  return (
    <div>
      <Flash text={sp.error ? decodeURIComponent(sp.error) : flashMap[sp.flash ?? ""] ?? ""} />
      <section className="overview-hero">
        <div>
          <h1>监控概览</h1>
          <p>把关注的美股和目标价格放在一处。所有报价都保留查询时间、行情时间与来源。</p>
        </div>
        <div><span>关注标的 · {stocks.length} 只 · USD</span></div>
      </section>

      <details className="card readiness">
        <summary>提醒可用状态 {keySet ? "· 已配置行情 Key" : "· 尚未配置行情 Key"}</summary>
        <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
        <p className="muted small">手动和自动查询命中有效报价时都会尝试提醒；实际送达请在接收端确认。</p>
      </details>

      <section className="query-bar">
        <div><h2>立即查询</h2><p>依次查询已启用的股票，查看最新报价与提醒结果。</p></div>
        {stocks.length === 0 ? <p>先添加股票并设置提醒价格。</p>
          : activeStocks === 0 ? <p>所有股票已暂停，请先启用股票。</p>
          : !keySet ? <p>尚未配置行情 Key。<Link href="/stocks/settings">前往设置 →</Link></p>
          : (
            <form action={startRunAction}>
              <button type="submit">立即查询 ↗</button>
            </form>
          )}
      </section>

      <div className="home-layout">
        <section className="card">
          <div className="panel-head">
            <div>
              <h2>监控股票</h2>
              <p>{stocks.length > 0 ? "管理买入或卖出提醒价格，也可继续添加股票。" : "先添加股票，再设置买入或卖出提醒价格。"}</p>
            </div>
          </div>
          <details>
            <summary>＋ 添加股票</summary>
            <form action={stockAddAction} className="level-fields">
              <label>股票代码<input name="symbol" placeholder="例如 AAPL" maxLength={15} required autoComplete="off" /></label>
              <label>备注<input name="note" maxLength={200} placeholder="可选" /></label>
              <button type="submit">保存</button>
            </form>
          </details>
          {stocks.length === 0 ? (
            <p className="empty-state">还没有股票。先添加一只股票。</p>
          ) : (
            <div className="watch-list">
              {stocks.map((s) => (
                <article className="watch-item" key={s.ID} id={`stock-${s.ID}`}>
                  <div className="watch-item-head">
                    <div>
                      <Link className="stock-symbol" href={`/stocks/${s.ID}`}>{s.Symbol}</Link>
                      {s.Note ? <p className="muted small">{s.Note}</p> : null}
                    </div>
                    <span>{s.Enabled ? "监控中" : "已暂停"}</span>
                  </div>
                  <div className="watch-item-meta">
                    <div>
                      <span>最近有效价格</span>
                      <strong>{s.LastPrice ? `${s.LastPrice} USD` : "—"}</strong>
                      <span className={`day-move ${s.DayClass}`}>较昨收 {s.DayPercent || "—"}</span>
                      <div>
                        <span>今开 USD</span><b>{s.Open || "—"}</b>
                        <span>昨收 USD</span><b>{s.PrevClose || "—"}</b>
                      </div>
                      <small>{s.LastPrice ? `${displayClock(new Date(s.LastAt), tz)} · ${s.LastSource}` : "尚无报价"}</small>
                    </div>
                    <div>
                      <span>最新查询</span>
                      <strong>{s.LastStatus ? statusText(s.LastStatus) : "尚未查询"}</strong>
                      {s.LastError ? <small>{s.LastError}</small> : null}
                    </div>
                  </div>
                  <p className="quote-readiness">{s.AlertReason}</p>
                  {s.WindowStatus ? <p className="info-strip">{s.WindowStatus}</p> : null}
                  <p className="muted small">以下差距基于上方最近保存报价，非实时行情。</p>
                  <section aria-label="买入目标价">
                    <h3>↓ 买入 {s.BuyLevels.length} 个 USD</h3>
                    {s.BuyLevels.length > 0 ? (
                      <div className="price-chips">
                        {s.BuyLevels.map((l) => (
                          <Link key={l.ID} href={`/stocks/${s.ID}?edit=${l.ID}#edit-level-${l.ID}`} className="price-chip">
                            <strong>≤ {l.Target}</strong>
                            {l.State ? <small>{l.State}</small> : null}
                            <small className="target-gap">{l.Gap}</small>
                            <small>{l.WindowActive ? `本时段已提醒 ${l.Used}/${l.Limit} 次` : l.MaxAlerts ? `每时段上限 ${l.MaxAlerts} 次` : "上限继承查询时段"}</small>
                          </Link>
                        ))}
                      </div>
                    ) : <span className="price-empty">尚未设置买入价格</span>}
                  </section>
                  <section aria-label="卖出目标价">
                    <h3>↑ 卖出 {s.SellLevels.length} 个 USD</h3>
                    {s.SellLevels.length > 0 ? (
                      <div className="price-chips">
                        {s.SellLevels.map((l) => (
                          <Link key={l.ID} href={`/stocks/${s.ID}?edit=${l.ID}#edit-level-${l.ID}`} className="price-chip">
                            <strong>≥ {l.Target}</strong>
                            {l.State ? <small>{l.State}</small> : null}
                            <small className="target-gap">{l.Gap}</small>
                            <small className="expected-profit">{l.Profit}</small>
                            <small>{l.WindowActive ? `本时段已提醒 ${l.Used}/${l.Limit} 次` : l.MaxAlerts ? `每时段上限 ${l.MaxAlerts} 次` : "上限继承查询时段"}</small>
                          </Link>
                        ))}
                      </div>
                    ) : <span className="price-empty">尚未设置卖出价格</span>}
                  </section>
                </article>
              ))}
            </div>
          )}
          <p className="muted small">预计收益按所选买入目标计算，不代表已经成交，不含手续费和税费。点击任一价格可修改提醒。</p>
        </section>
        <section className="card">
          <h2>查询记录</h2>
          <p className="muted">休市时可能返回最后可用价格；只有符合交易时段和有效性要求的报价才会触发提醒。</p>
          <div className="info-strip">时间按 {tz} 显示。没有启用通知渠道时，命中档位会显示为“未通知”。</div>
          <span>下一次自动查询</span>
          <p>{next ? <strong>{displayClock(next, tz)}</strong> : "尚未启用查询时间"}<br /><Link href="/stocks/schedule">管理查询时间 →</Link></p>
          <span>最近任务</span>
          {runs.length > 0 ? (
            <ul>
              {runs.map((r) => (
                <li key={r.id}>
                  <Link href={`/stocks/runs/${r.id}`}>查询 #{r.id}</Link> · {statusText(r.status)} · {r.done}/{r.total}
                  <br /><span className="muted small">{displayClock(new Date(r.started_at), tz)} {r.reason}</span>
                </li>
              ))}
            </ul>
          ) : <p className="muted">尚无查询记录。</p>}
        </section>
      </div>
    </div>
  );
}
