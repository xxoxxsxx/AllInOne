// 查询执行引擎（run.go runOnce + alert.go alert 语义）：
// - 手动与定时共用一条执行路径与进程内执行锁。
// - 额度：每次请求前先记账（8 次/分钟、800 次/24h）；429 按 Retry-After 有限重试一次。
// - 档位选择：每方向一个最近命中档位（dueLevels），时段内受每档上限约束。
// - 通知：向所有启用渠道发送同一内容；任一渠道成功/发送中/不确定即占用一次档位额度。

import { withQuoteQuota, QueryCancelled, QuotaError, type QueueOptions } from "./quota";
import type { Database } from "better-sqlite3";

import { calendarReviewed, isOpen, regularHours } from "./calendar";
import { cmpDec, decString, parseDecimal, stringFixed, type Decimal } from "./decimal";
import { RateLimitError, alertValidityLocal, fetchQuote, type Quote } from "./quote";
import {
  createRun,
  dueLevels,
  finishAttempt,
  finishRun,
  getStock,
  getRun,
  listStocks,
  now,
  recordAttemptChannels,
  reserveQuoteCall,
  saveResult,
  updateChannel,
  value,
} from "./store";
import type { Level, Result, Stock } from "./store";
import { enabledChannels, sendChannel } from "./notify";
import { getChannelConfig } from "@/lib/channels/center";
import { filterModuleChannels, getModulePolicy } from "@/lib/channels/module-policy";
import { normalizeQuoteProvider } from "./quote";
import { quoteSourceOf } from "./store";
import { activeWindow, windowUsage } from "./windows";
import { alertLimit } from "./store";
import { formatPrice } from "./price-format";
import { rfc3339Nano, type StockTimezone } from "./tz";

// 进程内执行锁：同一时刻仅一轮查询。
let runningID = 0;

export function currentRunningID(): number {
  return runningID;
}

export type FetchFn = (symbol: string, options?: QueueOptions) => Promise<Quote>;
const managedProviders = new WeakSet<FetchFn>();

// runOnce：执行一轮查询。stocks 为本轮要查的股票（已启用）。
export async function runOnce(
  db: Database,
  id: number,
  stocks: Stock[],
  provider: FetchFn,
  tz: StockTimezone,
  queueOptions: QueueOptions = {},
): Promise<void> {
  let reason = "";
  try {
    const runRow = db.prepare(`SELECT kind,slot_at FROM runs WHERE id=?`).get(id) as { kind: string; slot_at: string } | undefined;
    if (!runRow) {
      reason = "读取查询时段失败";
      return;
    }
    const kind = runRow.kind;
    let initial: { id: number; day: string } | null = null;
    if (kind === "scheduled") {
      const slot = parseRFC3339NanoOrNull(runRow.slot_at);
      if (!slot) {
        reason = "查询时间无效";
        return;
      }
      const active = activeWindow(db, slot, tz);
      initial = active ? { id: active.window.id, day: active.day } : null;
    }
    const canQuery = (s: Stock): string | null => {
      const currentStock=getStock(db,s.ID);
      if(!currentStock || !currentStock.Enabled || currentStock.Symbol!==s.Symbol) return "股票已停用、删除或改码";
      if (kind !== "scheduled") return null;
      if (initial) {
        const current = activeWindow(db, new Date(), tz);
        if (!current || current.window.id !== initial.id || current.day !== initial.day) {
          return "本查询时段已结束";
        }
        if (!current.window.enabled) {
          return "本查询时段已暂停";
        }
      }
      const { status, capped } = windowStatusOf(db, s.ID, s.Symbol, tz);
      if (capped) return status;
      return null;
    };
    for (const s of stocks) {
      let skip = canQuery(s);
      if (skip) {
        saveResult(db, id, { Symbol: s.Symbol, Status: "skipped", Error: skip, Price: "", Open: "", PrevClose: "", QuoteAt: "", FetchedAt: "", Source: "", TimeField: "", Delay: "", AlertStatus: "", AssetOK: false });
        continue;
      }
      let err: Error | null = null;
      let q: Quote | null = null;
      const options: QueueOptions = {...queueOptions, eligible:()=>canQuery(s), onWait:(until,reason)=>{
        db.prepare(`UPDATE runs SET wait_until=?,reason=? WHERE id=?`).run(until,reason,id);
        db.prepare(`UPDATE results SET status=? WHERE run_id=? AND symbol=?`).run(until ? 'pending' : 'querying',id,s.Symbol);
        queueOptions.onWait?.(until,reason);
      }};
      try {
        q = managedProviders.has(provider)
          ? await provider(s.Symbol, options)
          : await withQuoteQuota(db, () => provider(s.Symbol), options);
      } catch(e) {
        if(e instanceof QueryCancelled || e instanceof QuotaError) skip=e.message;
        else err=e instanceof Error?e:new Error(String(e));
      }
      if (skip) {
        saveResult(db, id, { Symbol: s.Symbol, Status: "skipped", Error: skip, Price: "", Open: "", PrevClose: "", QuoteAt: "", FetchedAt: "", Source: "", TimeField: "", Delay: "", AlertStatus: "", AssetOK: false });
        continue;
      }
      const fetched = new Date();
      const v: Result = { Symbol: s.Symbol, Status: "ok", FetchedAt: rfc3339Nano(fetched), Delay: "未知", Price: "", Open: "", PrevClose: "", QuoteAt: "", Source: "", TimeField: "", Error: "", AlertStatus: "", AssetOK: false };
      if (err && !q) {
        v.Status = "error";
        v.Error = err.message;
      } else if (q) {
        v.AssetOK = q.AssetOK;
        v.Price = decString(q.Price);
        v.Open = q.Open;
        v.PrevClose = q.PrevClose;
        v.QuoteAt = rfc3339Nano(q.At);
        v.Source = q.Source;
        v.TimeField = q.TimeField;
        v.Delay = q.Delay;
      }
      if (q) {
        v.AlertStatus = alertValidityLocal(q, fetched);
      }
      saveResult(db, id, v);
      if (q) {
        let status = "";
        skip = canQuery(s);
        if (skip) {
          status = skip;
        } else {
          status = await alert(db, id, s, q, fetched, tz);
        }
        db.prepare(`UPDATE results SET alert_status=? WHERE run_id=? AND symbol=?`).run(status, id, s.Symbol);
      }
    }
  } finally {
    db.prepare(`UPDATE runs SET wait_until=0 WHERE id=?`).run(id);
    finishRun(db, id, reason);
    runningID = 0;
  }
}

function windowStatusOf(db: Database, stockID: number, symbol: string, tz: StockTimezone): { status: string; capped: boolean } {
  // 延迟导入避免循环依赖：windows.levelUsage 已在本模块顶部引入。
  const levels = listLevelsFor(db, stockID);
  const active = activeWindow(db, new Date(), tz);
  if (!active) return { status: "", capped: false };
  const usage = windowUsage(db, active.window, active.day, symbol);
  let activeCount = 0;
  let exhausted = 0;
  for (const l of levels) {
    if (!l.Enabled) continue;
    activeCount++;
    const used = usage.get(l.UID) ?? 0;
    const limit = alertLimit(l, active.window);
    if (used >= limit) exhausted++;
  }
  const status = `本时段档位额度：${exhausted}/${activeCount} 个已用尽`;
  if (activeCount > 0 && exhausted === activeCount) return { status: status + " · 本时段自动查询已停止", capped: true };
  if (!active.window.enabled) return { status: status + " · 时段查询已暂停", capped: false };
  return { status, capped: false };
}

function listLevelsFor(db: Database, stockID: number): Level[] {
  const rows = db.prepare(`SELECT id,stock_id,side,target,note,enabled,generation,alerted_generation,mode,cooldown,last_attempt,max_alerts,uid FROM levels WHERE stock_id=? ORDER BY id`).all(stockID) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ID: Number(r.id),
    StockID: Number(r.stock_id),
    Generation: Number(r.generation),
    Side: String(r.side),
    Target: String(r.target),
    Note: String(r.note),
    UID: String(r.uid),
    Enabled: Number(r.enabled) === 1,
    State: Number(r.enabled) === 1 ? "" : "已暂停",
    Mode: String(r.mode),
    Cooldown: Number(r.cooldown),
    LastAttempt: String(r.last_attempt),
    Profit: "",
    Gap: "",
    MaxAlerts: Number(r.max_alerts),
    Used: 0,
    Limit: 0,
    WindowActive: false,
  }));
}

// alert：有效性校验 → 档位选择 → 渠道发送 → 记录（alert.go）。
export async function alert(
  db: Database,
  runID: number,
  s: Stock,
  q: Quote,
  fetched: Date,
  tz: StockTimezone,
): Promise<string> {
  // 每次告警实时读取，设置保存后下一次触价即可生效；关闭不创建发送记录或占用档位额度。
  const policy = getModulePolicy(db, "stocks", false);
  if (!policy.enabled) return "股票自动推送已关闭";
  const why = alertValidityLocal(q, fetched);
  if (why !== "") return why;
  // 网络调用期间股票被暂停或改码，不得再触发新提醒。
  const current = getStock(db, s.ID);
  if (!current || !current.Enabled || current.Symbol !== s.Symbol) {
    return "股票已变更，未触价";
  }
  const levels = dueLevels(db, s.ID, q.Price);
  if (levels.length === 0) {
    return "价格未命中已启用的提醒";
  }
  // 渠道配置统一来自全局推送渠道中心（与证件夹/提醒事项共用）；行情设置表里的旧渠道字段已退役。
  const c = filterModuleChannels(getChannelConfig(), policy);
  const channels = enabledChannels(c);
  if (channels.length === 0) {
    recordAttemptChannels(db, runID, { Symbol: q.Symbol, Price: decString(q.Price), QuoteAt: q.At }, levels, "命中但未通知（无启用渠道）", 0, "", []);
    return "命中但未通知（无启用渠道）";
  }
  const active = activeWindow(db, new Date(), tz);
  if (active) {
    const usage = windowUsage(db, active.window, active.day, s.Symbol);
    const eligible = levels.filter((l) => (usage.get(l.UID) ?? 0) < alertLimit(l, active.window));
    if (eligible.length === 0) {
      return "命中档位已达本时段上限";
    }
    levels.length = 0;
    levels.push(...eligible);
  }
  const id = recordAttemptChannels(
    db,
    runID,
    { Symbol: q.Symbol, Price: decString(q.Price), QuoteAt: q.At },
    levels,
    "发送中",
    active ? active.window.id : 0,
    active ? active.day : "",
    channels,
  );
  const lines = levels.map((l) => {
    const side = l.Side === "sell" ? "卖出" : "买入";
    const op = l.Side === "sell" ? "≥" : "≤";
    return `${side} ${op} ${formatPrice(l.Target)} USD`;
  });
  const body = `${lines.join("\n")}\n查询价 ${stringFixed(q.Price, 2)} USD · 行情时间 ${q.At.toISOString().replace(/\.\d{3}Z$/, "Z")} · ${q.Source}\n仅供提醒，非交易指令`;
  const results: Array<{ Name: string; Status: string; Error: string }> = [];
  for (const name of channels) {
    updateChannel(db, id, name, "发送中", "");
    const outcome = await sendChannel(c, name, `触价提醒 · ${s.Symbol}`, body);
    updateChannel(db, id, name, outcome.status, outcome.error);
    results.push({ Name: name, Status: outcome.status, Error: outcome.error });
  }
  const status = channelStatusOf(results);
  const detail = status !== "成功" ? "请查看各渠道发送结果" : "";
  finishAttempt(db, id, runID, s.Symbol, status, detail);
  return status;
}

function channelStatusOf(results: Array<{ Name: string; Status: string; Error: string }>): string {
  let success = 0;
  let uncertain = 0;
  for (const r of results) {
    if (r.Status === "成功") success++;
    if (r.Status === "不确定" || r.Status === "发送中") uncertain++;
  }
  if (success === results.length) return "成功";
  if (success > 0) return "部分成功";
  if (uncertain > 0) return "不确定";
  return "失败";
}

// 手动查询入口（run.go runPost 语义，不含 HTTP 层）。
// reused=true 表示已有任务在执行，本次点击复用该任务（不新建、不重复排队）。
export function startManualRun(db: Database, tz: StockTimezone, provider?: FetchFn): { ok: true; id: number; reused: boolean } | { ok: false; error: string } {
  if (runningID !== 0) {
    return { ok: true, id: runningID, reused: true };
  }
  const src = quoteSourceOf(db);
  const p = normalizeQuoteProvider(src.provider);
  const key = (p === "finnhub" ? src.finnhubKey : src.twelvedataKey).trim();
  if (key === "") {
    return { ok: false, error: p === "finnhub" ? "先在设置页配置 Finnhub API Key" : "先在设置页配置 Twelve Data Key" };
  }
  const all = listStocks(db);
  const stocks = all.filter((s) => s.Enabled);
  if (stocks.length === 0) return { ok: false, error: "请先添加并启用股票" };
  const id = createRun(db, stocks, "manual", 0, "", "");
  runningID = id;
  void runOnce(db, id, stocks, provider ?? defaultProvider(db), tz).catch(() => undefined);
  return { ok: true, id, reused: false };
}

export function defaultProvider(db: Database): FetchFn {
  const { provider: rawProvider, twelvedataKey, finnhubKey } = quoteSourceOf(db);
  const p = normalizeQuoteProvider(rawProvider);
  const key = (p === "finnhub" ? finnhubKey : twelvedataKey).trim();
  const proxy = value(db, `SELECT proxy_url FROM settings WHERE id=1`);
  const provider:FetchFn = (symbol,options) => fetchQuote(symbol,key,proxy,options?.now ?? (()=>new Date()),{...options,db,provider:p});
  managedProviders.add(provider);
  return provider;
}

// 定时查询入口（scheduler.go scheduled 的执行部分）。
export function startScheduledRun(db: Database, stocks: Stock[], scheduleID: number, due: string, slotAt: string, tz: StockTimezone): number {
  if(runningID !== 0) return runningID;
  const id = createRun(db, stocks, "scheduled", scheduleID, due, slotAt);
  runningID = id;
  void runOnce(db, id, stocks, defaultProvider(db), tz).catch(() => undefined);
  return id;
}

function parseRFC3339NanoOrNull(s: string): Date | null {
  if (s === "") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 供测试：重置执行锁。
export function resetRunningLock(): void {
  runningID = 0;
}

// 供测试：直接注入运行中的 run id（模拟「上一轮仍在运行」）。
export function setRunningID(id: number): void {
  runningID = id;
}

// 引用保留：parseDecimal/stringFixed/cmpDec 由告警正文与档位比较间接使用。
export type { Decimal };
void cmpDec;
void parseDecimal;
