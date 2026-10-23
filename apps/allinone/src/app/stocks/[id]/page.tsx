import Link from "next/link";
import { notFound } from "next/navigation";

import { getDB, listStocks, getStock, listStockQuotes, listNotifications, listLevels, alertLimit, targetGap, setReturns, expectedReturn } from "@/modules/stocks/store";
import { levelUsage, timezoneValue } from "@/modules/stocks/windows";
import { displayClock } from "@/modules/stocks/tz";
import { statusText } from "../display";
import { stockUpdateAction, stockDeleteAction, stockReferenceAction, levelAddAction, levelUpdateAction, levelActionAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "股票详情 · TickerSentry" };

export default async function StockPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ flash?: string; error?: string; edit?: string; updated?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const db = getDB();
  const tz = timezoneValue(db);
  const numericID = Number(id);
  if (!Number.isInteger(numericID) || numericID <= 0) notFound();
  const base = getStock(db, numericID);
  if (!base) notFound();
  // 报价信息取自最近一次成功结果（web.go stockPage 从 listStocks 复制）。
  const all = listStocks(db);
  const info = all.find((s) => s.ID === numericID);
  const stock = { ...base };
  stock.LastPrice = info?.LastPrice ?? "";
  stock.Open = info?.Open ?? "";
  stock.PrevClose = info?.PrevClose ?? "";
  stock.DayChange = info?.DayChange ?? "";
  stock.DayPercent = info?.DayPercent ?? "";
  stock.DayClass = info?.DayClass ?? "";
  stock.LastAt = info?.LastAt ?? "";
  stock.LastSource = info?.LastSource ?? "";
  stock.LastStatus = info?.LastStatus ?? "";
  stock.LastError = info?.LastError ?? "";
  const { levels, window: activeWin } = levelUsage(db, numericID, stock.Symbol, new Date(), tz);
  const buyLevels = levels.filter((l) => l.Side === "buy");
  const sellLevels = levels.filter((l) => l.Side === "sell");
  stock.BuyLevels = buyLevels;
  stock.SellLevels = sellLevels;
  setReturns(stock);
  for (const l of levels) {
    if (l.Side === "sell") l.Profit = expectedReturn(stock.BuyBasis, l.Target);
    l.Gap = targetGap(l.Side, l.Target, stock.LastPrice);
    // 详情页时段未激活时也展示上限继承提示（Go 版仅激活时显示 Used/Limit）。
    if (!l.WindowActive) {
      l.Limit = alertLimit(l, activeWin);
    }
  }
  const notifications = listNotifications(db, stock.Symbol);
  const quotes = listStockQuotes(db, stock.Symbol);
  const flashMap: Record<string, string> = {
    stock_added: "股票已添加，可在下方设置提醒价格。",
    stock_saved: "股票设置已保存。",
    level_added: "提醒价格已添加。",
    level_paused: "提醒已暂停。",
    level_enabled: "提醒已恢复。",
    level_rearmed: "提醒已重新启用。",
    level_deleted: "提醒已删除。",
  };
  const notice = sp.error ?? flashMap[sp.flash ?? ""] ?? "";
  const editID = sp.edit ? Number(sp.edit) : 0;
  const updatedID = sp.updated ? Number(sp.updated) : 0;

  return (
    <div>
      {notice ? <p className="info-strip" role="status">{notice}</p> : null}
      <div className="page-head">
        <div>
          <Link className="back-link" href="/">← 返回监控概览</Link>
          <h1>{stock.Symbol}</h1>
          <p>{stock.Note || "管理价格档位、查询记录与提醒状态。"}</p>
        </div>
        <span>{stock.Enabled ? "监控中" : "已暂停"}</span>
      </div>
      <nav className="stock-actions" aria-label="股票操作">
        <a className="primary-link" href="#add-level">添加提醒价格</a>
        <a href="#stock-settings">修改股票</a>
        <a href="#delete-stock">删除股票</a>
      </nav>
      <section className="card stock-summary">
        <div>
          <span>最近有效价格</span>
          <strong>{stock.LastPrice ? `${stock.LastPrice} USD` : "—"}</strong>
          <span className={`day-move ${stock.DayClass}`}>较昨收 {stock.DayPercent ? `${stock.DayPercent} · ${stock.DayChange} USD` : "—"}</span>
          <div>
            <span>今开 USD</span><b>{stock.Open || "—"}</b>
            <span>昨收 USD</span><b>{stock.PrevClose || "—"}</b>
          </div>
          <span className="muted">{stock.LastPrice ? `${displayClock(new Date(stock.LastAt), tz)} · ${stock.LastSource}` : "尚无有效报价"}</span>
        </div>
        <div>
          <span>最新查询</span>
          <strong>{stock.LastStatus ? statusText(stock.LastStatus) : "暂无记录"}</strong>
          <span className="muted">{stock.LastError}</span>
        </div>
      </section>

      <section className="card" id="price-levels">
        <h2>提醒价格</h2>
        <p>同一只股票可添加多个价格，每个价格单独管理。</p>
        <div id="add-level">
          <h3>添加提醒价格</h3>
          <p className="muted small">买入：报价低于或等于目标价；卖出：报价高于或等于目标价。</p>
          <form action={levelAddAction} className="level-fields">
            <input type="hidden" name="id" value={stock.ID} />
            <fieldset>
              <legend>提醒方向</legend>
              <label><input type="radio" name="side" value="buy" defaultChecked required />↓ 买入提醒 价格 ≤ 目标价</label>
              <label><input type="radio" name="side" value="sell" required />↑ 卖出提醒 价格 ≥ 目标价</label>
            </fieldset>
            <label>目标价 (USD)<input name="target" inputMode="decimal" required placeholder="例如 150.00" /></label>
            <label>本档每时段提醒上限（次）<input type="number" name="max_alerts" min={1} max={1000} placeholder="留空继承时段默认值" /></label>
            <label>备注<input name="note" maxLength={200} placeholder="可选" /></label>
            <button type="submit">添加提醒</button>
          </form>
        </div>
        <details className="rule-help">
          <summary>提醒什么时候会发送？</summary>
          <p>每次有效查询，买入选择已命中的最低目标价，卖出选择已命中的最高目标价；同价位只选最早创建的档位。各档独立计数，已用尽的档位不会转用其他档位次数。买入与卖出同时命中时合并一条通知，分别扣各自次数。所有启用档位的时段额度都用尽后，停止这只股票的本时段自动查询。</p>
        </details>
        <h3>已设置的提醒价格</h3>
        {levels.length === 0 ? (
          <p className="empty-state">还没有提醒价格。上方可添加买入或卖出价格。</p>
        ) : (
          levels.map((l) => (
            <div className={`level-card level-${l.Side}`} id={`level-${l.ID}`} key={l.ID}>
              {updatedID === l.ID ? <p className="info-strip" role="status">提醒已保存。</p> : null}
              <div className="level-heading">
                <span className="side-badge">{l.Side === "buy" ? "↓ 买入提醒" : "↑ 卖出提醒"}</span>
                <span>{l.Enabled ? "每次命中提醒" : "已暂停"}</span>
              </div>
              <div className="target-price"><span>{l.Side === "buy" ? "≤" : "≥"}</span> <strong>{l.Target}</strong> <small>USD</small></div>
              <p className="target-rule">{l.Side === "buy" ? "报价低于或等于此价格时提醒买入" : "报价高于或等于此价格时提醒卖出"}</p>
              <p className="target-gap">{l.Gap} · 基于上方保存报价</p>
              <p className="level-quota">
                {l.MaxAlerts ? `本档每时段最多 ${l.MaxAlerts} 次` : "本档上限继承查询时段默认值"}
                {l.WindowActive ? <> · 当前时段已提醒 <strong>{l.Used}/{l.Limit} 次</strong></> : null}
              </p>
              {l.Note ? <p className="level-note">{l.Note}</p> : null}
              <details className="level-edit" id={`edit-level-${l.ID}`} open={editID === l.ID}>
                <summary>修改提醒 · 价格 / 方向 / 上限</summary>
                <form action={levelUpdateAction} className="level-fields">
                  <input type="hidden" name="id" value={stock.ID} />
                  <input type="hidden" name="level" value={l.ID} />
                  <fieldset>
                    <legend>提醒方向</legend>
                    <label><input type="radio" name="side" value="buy" defaultChecked={l.Side === "buy"} required />↓ 买入提醒</label>
                    <label><input type="radio" name="side" value="sell" defaultChecked={l.Side === "sell"} required />↑ 卖出提醒</label>
                  </fieldset>
                  <label>目标价 (USD)<input name="target" inputMode="decimal" required defaultValue={l.Target} /></label>
                  <label>本档每时段提醒上限（次）<input type="number" name="max_alerts" min={1} max={1000} placeholder="留空继承时段默认值" defaultValue={l.MaxAlerts || undefined} /></label>
                  <label>备注<input name="note" maxLength={200} defaultValue={l.Note} /></label>
                  <div><button type="submit">保存修改</button><Link href={`/stocks/${stock.ID}#level-${l.ID}`}>取消</Link></div>
                </form>
              </details>
              <div className="level-actions">
                {l.Enabled ? (
                  <form action={levelActionAction}>
                    <input type="hidden" name="id" value={stock.ID} />
                    <input type="hidden" name="level" value={l.ID} />
                    <input type="hidden" name="action" value="pause" />
                    <button type="submit">暂停</button>
                  </form>
                ) : (
                  <form action={levelActionAction}>
                    <input type="hidden" name="id" value={stock.ID} />
                    <input type="hidden" name="level" value={l.ID} />
                    <input type="hidden" name="action" value="enable" />
                    <button type="submit">恢复</button>
                  </form>
                )}
                <form action={levelActionAction}>
                  <input type="hidden" name="id" value={stock.ID} />
                  <input type="hidden" name="level" value={l.ID} />
                  <input type="hidden" name="action" value="delete" />
                  <button type="submit">删除提醒</button>
                </form>
              </div>
            </div>
          ))
        )}
        {listLevels(db, numericID).length > 0 && stock.BuyLevels.length > 0 ? (
          <form action={stockReferenceAction} className="reference-form">
            <input type="hidden" name="id" value={stock.ID} />
            <label>收益参考买入价
              <select name="reference_buy" defaultValue={stock.BuyBasis}>
                {stock.BuyLevels.map((l) => (
                  <option key={l.ID} value={l.Target}>{l.Target} USD{l.Enabled ? "" : "（已暂停）"}</option>
                ))}
              </select>
            </label>
            <button type="submit">保存</button>
          </form>
        ) : null}
        <p className="muted small">未选择时使用最高买入价；参考目标删除后自动回退。</p>
      </section>

      <section className="card">
        <h2>预计卖出收益</h2>
        <p className="muted">收益参考买入价：{stock.BuyBasis ? `${stock.BuyBasis} USD（可在首页切换）` : "尚未设置"}。按目标价计算每股收益，不代表已成交，不含手续费和税费。</p>
        {stock.SellLevels.length > 0 ? (
          <div className="price-chips">
            {stock.SellLevels.map((l) => (
              <div className="price-chip" key={l.ID}>
                <strong>卖出 ≥ {l.Target} USD</strong>
                <span>{l.Profit}</span>
              </div>
            ))}
          </div>
        ) : <p>添加卖出目标后即可查看。</p>}
      </section>

      <section className="card" id="stock-settings">
        <h2>股票设置</h2>
        <p>修改代码会重新启用所有档位提醒。</p>
        <form action={stockUpdateAction} className="stock-form">
          <input type="hidden" name="id" value={stock.ID} />
          <label>股票代码<input name="symbol" maxLength={15} required defaultValue={stock.Symbol} /></label>
          <label>备注<input name="note" maxLength={200} defaultValue={stock.Note} /></label>
          <label className="check"><input type="checkbox" name="enabled" value="1" defaultChecked={stock.Enabled} />启用查询</label>
          <button type="submit">保存设置</button>
        </form>
      </section>

      <div className="settings-grid history-grid">
        <section className="card">
          <h2>最近查询</h2>
          {quotes.length > 0 ? (
            <ul className="record-list">
              {quotes.map((q, i) => (
                <li key={`${q.RunID}-${i}`}>
                  <Link href={`/stocks/runs/${q.RunID}`}>查询 #{q.RunID}</Link>
                  <span>{statusText(q.Status)} {q.Error}</span>
                  {q.Price ? (
                    <>
                      <strong>{q.Price} USD</strong>
                      <div>
                        <span>今开 USD</span><b>{q.Open || "—"}</b>
                        <span>昨收 USD</span><b>{q.PrevClose || "—"}</b>
                      </div>
                      <small>行情 {displayClock(new Date(q.QuoteAt), tz)} · 查询 {displayClock(new Date(q.FetchedAt), tz)} · {q.Source}</small>
                    </>
                  ) : null}
                  {q.AlertStatus ? <small>提醒：{q.AlertStatus}</small> : null}
                </li>
              ))}
            </ul>
          ) : <p className="empty-state">暂无查询记录。</p>}
        </section>
        <section className="card">
          <h2>通知记录</h2>
          {notifications.length > 0 ? (
            <ul className="record-list">
              {notifications.map((n) => (
                <li key={n.ID}>
                  <Link href={`/stocks/runs/${n.RunID}`}>查询 #{n.RunID}</Link>
                  <span>{n.Status} {n.Error}</span>
                  <small>{displayClock(new Date(n.CreatedAt), tz)} · {n.Price} USD</small>
                  {n.Channels.map((c) => <small key={c.Name}>{c.Name}：{c.Status} {c.Error}</small>)}
                  <small>档位快照：{n.Levels}</small>
                </li>
              ))}
            </ul>
          ) : <p className="empty-state">暂无通知尝试。</p>}
        </section>
      </div>

      <section className="card" id="delete-stock">
        <h2>删除股票</h2>
        <p className="muted">删除后提醒价格随之移除，历史查询和通知记录仍会保留。</p>
        <form action={stockDeleteAction} className="danger">
          <input type="hidden" name="id" value={stock.ID} />
          <label>输入股票代码 {stock.Symbol} 确认删除<input name="confirm" required autoComplete="off" spellCheck={false} /></label>
          <button type="submit">确认删除 {stock.Symbol}</button>
        </form>
      </section>
    </div>
  );
}
