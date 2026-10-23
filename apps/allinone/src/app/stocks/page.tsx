import Link from "next/link";

import {
  apiKeyOf,
  getDB,
  listRuns,
  listStocks,
  notificationSettings,
  queryWindows,
  schedules,
  setReturns,
  targetGap,
} from "@/modules/stocks/store";
import { activeWindow, levelUsage, timezoneValue, windowUsageAll } from "@/modules/stocks/windows";
import { nextFireForSchedule, nextWindowOccurrence } from "@/modules/stocks/next-fire";
import { quoteReadiness, readiness } from "@/modules/stocks/readiness";
import { displayClock } from "@/modules/stocks/tz";
import { flashText, money, statusText } from "./display";
import { stockReferenceAction } from "./actions";
import { Flash, RunNowButton, StockDialog, WatchFilter } from "./stocks-client";

export const dynamic = "force-dynamic";

// 原版 web.go home：Title 为「监控列表」。
export const metadata = { title: "监控列表 · TickerSentry" };

// DOM 结构对应 templates/home.html（含 stock-dialog）。
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
  const keySet = apiKeyOf(db) !== "";
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
  const items = readiness(notificationSettings(db), keySet, next !== null, nowD);

  return (
    <div>
      {sp.error ? (
        <p className="info-strip" role="alert">
          {sp.error}
        </p>
      ) : null}
      <Flash text={flashText(sp.flash ?? "")} />

      <section className="overview-hero">
        <div>
          <span className="eyebrow">YOUR WATCHLIST</span>
          <h1>监控概览</h1>
          <p>把关注的美股和目标价格放在一处。所有报价都保留查询时间、行情时间与来源。</p>
        </div>
        <div className="hero-meta">
          <span>关注标的 · {stocks.length} 只 · USD</span>
          <button className="primary add-stock-button" type="button" data-add-stock="true">
            ＋ 添加股票
          </button>
        </div>
      </section>

      <section className="query-bar" aria-labelledby="query-title">
        <div>
          <h2 id="query-title">立即查询</h2>
          <p>依次查询已启用的股票，查看最新报价与提醒结果。</p>
        </div>
        {stocks.length === 0 ? (
          <p className="query-status">先添加股票并设置提醒价格。</p>
        ) : activeStocks === 0 ? (
          <p className="query-status">所有股票已暂停，请先启用股票。</p>
        ) : !keySet ? (
          <p className="query-status">
            尚未配置行情 Key。<Link href="/stocks/settings">前往设置 →</Link>
          </p>
        ) : (
          <RunNowButton />
        )}
      </section>

      <details className="card readiness">
        <summary>提醒可用状态 · {keySet ? "展开检查行情与通知配置" : "尚未配置行情 Key"}</summary>
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <a href="/stocks/settings">检查行情与通知设置 →</a> · <a href="/stocks/schedule">管理查询时间 →</a>
        <p className="muted small">手动和自动查询命中有效报价时都会尝试提醒；实际送达请在接收端确认。</p>
      </details>

      <div className="home-layout">
        <section className="card">
          <div className="panel-head">
            <div>
              <span className="eyebrow">WATCHLIST</span>
              <h2>监控股票</h2>
              <p>{stocks.length > 0 ? "管理买入或卖出提醒价格，也可继续添加股票。" : "先添加股票，再设置买入或卖出提醒价格。"}</p>
            </div>
            <button className="primary add-stock-button" type="button" data-add-stock="true">
              ＋ 添加股票
            </button>
          </div>
          {stocks.length === 0 ? (
            <p className="empty-state">还没有股票。点击「＋ 添加股票」开始设置。</p>
          ) : (
            <>
              <div className="watch-toolbar">
                <label>
                  搜索股票
                  <input id="stock-search" type="search" placeholder="输入代码或备注" />
                </label>
                <label>
                  监控状态
                  <select id="stock-filter" defaultValue="all">
                    <option value="all">全部股票</option>
                    <option value="active">监控中</option>
                    <option value="paused">已暂停</option>
                    <option value="capped">本时段全部档位已达上限</option>
                  </select>
                </label>
                <span id="stock-count" aria-live="polite"></span>
              </div>
              <WatchFilter />
              <div className="watch-columns" aria-hidden="true">
                <span>股票 / 报价</span>
                <span>↓ 买入目标</span>
                <span>↑ 卖出目标 / 预计收益</span>
              </div>
              <div className="watch-list">
                {stocks.map((s) => (
                  <article
                    className="watch-item"
                    id={`stock-${s.ID}`}
                    key={s.ID}
                    data-symbol={s.Symbol}
                    data-note={s.Note}
                    data-enabled={s.Enabled ? "true" : "false"}
                    data-capped={s.WindowCapped ? "true" : "false"}
                  >
                    <div className="watch-overview">
                      <div className="watch-item-head">
                        <div>
                          <Link className="stock-symbol" href={`/stocks/${s.ID}`}>
                            {s.Symbol}
                          </Link>
                          {s.Note ? <p className="muted small">{s.Note}</p> : null}
                        </div>
                        <span className={`status-pill${s.Enabled ? "" : " is-off"}`}>{s.Enabled ? "监控中" : "已暂停"}</span>
                      </div>
                      <div className="watch-actions">
                        <Link className="primary-link" href={`/stocks/${s.ID}#price-levels`}>
                          管理提醒价格
                        </Link>
                        <Link href={`/stocks/${s.ID}#stock-settings`}>修改股票</Link>
                        <Link href={`/stocks/${s.ID}#delete-stock`}>删除股票</Link>
                      </div>
                      <div className="watch-item-meta">
                        <div>
                          <span>最近有效价格</span>
                          <strong>{s.LastPrice ? <>{money(s.LastPrice)} <small>USD</small></> : "—"}</strong>
                          <span className={`day-move ${s.DayClass}`}>较昨收 {s.DayPercent || "—"}</span>
                          <div className="session-prices">
                            <div className="session-price">
                              <span>
                                今开 <small>USD</small>
                              </span>
                              <b>{s.Open ? money(s.Open) : "—"}</b>
                            </div>
                            <div className="session-price">
                              <span>
                                昨收 <small>USD</small>
                              </span>
                              <b>{s.PrevClose ? money(s.PrevClose) : "—"}</b>
                            </div>
                          </div>
                          <small>
                            {s.LastPrice ? (
                              <>
                                {displayClock(new Date(s.LastAt), tz)} · {s.LastSource}
                              </>
                            ) : (
                              "尚无报价"
                            )}
                          </small>
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
                    </div>
                    <div className="watch-prices">
                      <section className="price-group level-buy" aria-label="买入目标价">
                        <h3>
                          ↓ 买入 <b>{s.BuyLevels.length}</b> 个 <small>USD</small>
                        </h3>
                        {s.BuyLevels.length > 0 ? (
                          <>
                            <form action={stockReferenceAction} className="reference-form">
                              <input type="hidden" name="id" value={s.ID} />
                              <label>
                                收益参考买入价
                                <select name="reference_buy" defaultValue={s.BuyBasis}>
                                  {s.BuyLevels.map((l) => (
                                    <option key={l.ID} value={l.Target}>
                                      {money(l.Target)} USD{l.Enabled ? "" : "（已暂停）"}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <button type="submit">保存</button>
                            </form>
                            <p className="muted small">未选择时使用最高买入价；参考目标删除后自动回退。</p>
                          </>
                        ) : null}
                        <div className="price-chips">
                          {s.BuyLevels.length > 0 ? (
                            s.BuyLevels.map((l) => (
                              <Link
                                key={l.ID}
                                href={`/stocks/${s.ID}?edit=${l.ID}#edit-level-${l.ID}`}
                                className={`price-chip${l.Enabled ? "" : " is-paused"}`}
                              >
                                <strong>≤ {money(l.Target)}</strong>
                                {l.State ? <small>{l.State}</small> : null}
                                <small className="target-gap">{l.Gap}</small>
                                <small
                                  className={`price-quota${l.WindowActive && l.Enabled && l.Used >= l.Limit ? " is-exhausted" : ""}`}
                                >
                                  {l.WindowActive
                                    ? `本时段已提醒 ${l.Used}/${l.Limit} 次`
                                    : l.MaxAlerts
                                      ? `每时段上限 ${l.MaxAlerts} 次`
                                      : "上限继承查询时段"}
                                </small>
                                <small className="price-edit">修改提醒 →</small>
                              </Link>
                            ))
                          ) : (
                            <span className="price-empty">尚未设置买入价格</span>
                          )}
                        </div>
                      </section>
                      <section className="price-group level-sell" aria-label="卖出目标价">
                        <h3>
                          ↑ 卖出 <b>{s.SellLevels.length}</b> 个 <small>USD</small>
                        </h3>
                        <div className="price-chips">
                          {s.SellLevels.length > 0 ? (
                            s.SellLevels.map((l) => (
                              <Link
                                key={l.ID}
                                href={`/stocks/${s.ID}?edit=${l.ID}#edit-level-${l.ID}`}
                                className={`price-chip${l.Enabled ? "" : " is-paused"}`}
                              >
                                <strong>≥ {money(l.Target)}</strong>
                                {l.State ? <small>{l.State}</small> : null}
                                <small className="target-gap">{l.Gap}</small>
                                <small className="expected-profit">{l.Profit}</small>
                                <small
                                  className={`price-quota${l.WindowActive && l.Enabled && l.Used >= l.Limit ? " is-exhausted" : ""}`}
                                >
                                  {l.WindowActive
                                    ? `本时段已提醒 ${l.Used}/${l.Limit} 次`
                                    : l.MaxAlerts
                                      ? `每时段上限 ${l.MaxAlerts} 次`
                                      : "上限继承查询时段"}
                                </small>
                                <small className="price-edit">修改提醒 →</small>
                              </Link>
                            ))
                          ) : (
                            <span className="price-empty">尚未设置卖出价格</span>
                          )}
                        </div>
                      </section>
                    </div>
                  </article>
                ))}
              </div>
              <p id="no-stock-match" className="empty-state" hidden>
                没有符合条件的股票，试试其他代码或状态。
              </p>
            </>
          )}
          <p className="muted small">预计收益按所选买入目标计算，不代表已经成交，不含手续费和税费。点击任一价格可修改提醒。</p>
        </section>

        <section className="card">
          <span className="eyebrow">QUERY HISTORY</span>
          <h2>查询记录</h2>
          <p className="muted">休市时可能返回最后可用价格；只有符合交易时段和有效性要求的报价才会触发提醒。</p>
          <div className="info-strip">时间按 {tz} 显示。没有启用通知渠道时，命中档位会显示为“未通知”。</div>
          <span className="section-label">下一次自动查询</span>
          <p>
            {next ? <strong>{displayClock(next, tz)}</strong> : "尚未启用查询时间"}
            <br />
            <Link href="/stocks/schedule">管理查询时间 →</Link>
          </p>
          <span className="section-label">最近任务</span>
          {runs.length > 0 ? (
            <ul>
              {runs.map((r) => (
                <li key={r.id}>
                  <Link href={`/stocks/runs/${r.id}`}>查询 #{r.id}</Link> · {statusText(r.status)} · {r.done}/{r.total}
                  <br />
                  <span className="muted small">
                    {displayClock(new Date(r.started_at), tz)} {r.reason}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">尚无查询记录。</p>
          )}
        </section>
      </div>

      <StockDialog />
    </div>
  );
}
