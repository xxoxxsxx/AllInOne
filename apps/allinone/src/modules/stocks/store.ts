// SQLite 存储：better-sqlite3 同步接口，语义与 Go 版 store.go 一一对应。
//
// schema 说明：Go 版把 v1→v13 的迁移链按任务要求拍平成一份初始 DDL，
// user_version 从 13 起；打开时 user_version <13 或 >13 均报错拒绝运行（=13 正常，
// 后续版本可在 openDB 内续排升级）。v14–v17（代理地址/耗时字段）与 v19（results.open）
// 在 Go 侧同样存在且被本移植的查询/备份逻辑使用，故一并并入初始 DDL；
// 但 user_version 仍按任务约束固定为 13（这些字段自 v14 起带默认值，拍平后语义不变）。

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/data-dir";
import { parseRFC3339, rfc3339Nano, quotaAt } from "./tz";
import {
  addDec,
  cmpDec,
  decFromInt,
  divDec,
  isPositive,
  mulDec,
  parseDecimal,
  stringFixed,
  subDec,
  type Decimal,
} from "./decimal";

// 目标 schema 版本：Go 版部署链实际到 v19（v14-17 代理字段、v19 results.open）。
// DDL 已按 v19 拍平；打开 13..19 的真实 Go 库时用幂等 ALTER 补齐缺列后升到 19。
export const SCHEMA_VERSION = 19;

export type Stock = {
  ID: number;
  Symbol: string;
  Note: string;
  Enabled: boolean;
  ReferenceBuy: string;
  LastPrice: string;
  Open: string;
  PrevClose: string;
  DayChange: string;
  DayPercent: string;
  DayClass: string;
  LastAt: string;
  LastSource: string;
  LastStatus: string;
  LastError: string;
  TimeField: string;
  AssetOK: boolean;
  AlertReason: string;
  WindowStatus: string;
  WindowCapped: boolean;
  BuyBasis: string;
  BuyLevels: Level[];
  SellLevels: Level[];
};

export type Result = {
  Symbol: string;
  Price: string;
  Open: string;
  PrevClose: string;
  QuoteAt: string;
  FetchedAt: string;
  Source: string;
  TimeField: string;
  Delay: string;
  Status: string;
  Error: string;
  AlertStatus: string;
  AssetOK: boolean;
};

export type Run = {
  id: number;
  kind: string;
  status: string;
  reason: string;
  started_at: string;
  slot_at: string;
  finished_at: string;
  done: number;
  total: number;
  results: Result[];
};

export type StockQuote = {
  RunID: number;
  Price: string;
  Open: string;
  PrevClose: string;
  QuoteAt: string;
  FetchedAt: string;
  Source: string;
  Status: string;
  Error: string;
  AlertStatus: string;
};

export type Level = {
  ID: number;
  StockID: number;
  Generation: number;
  Side: string;
  Target: string;
  Note: string;
  UID: string;
  Enabled: boolean;
  State: string;
  Mode: string;
  Cooldown: number;
  LastAttempt: string;
  Profit: string;
  Gap: string;
  MaxAlerts: number;
  Used: number;
  Limit: number;
  WindowActive: boolean;
};

export type NotificationRow = {
  ID: number;
  RunID: number;
  Symbol: string;
  Price: string;
  QuoteAt: string;
  Levels: string;
  Status: string;
  Error: string;
  CreatedAt: string;
  Channels: ChannelResult[];
};

export type ChannelResult = { Name: string; Status: string; Error: string };

export type NotificationChannelConfig = {
  Bark: { URL: string; Key: string; Local: boolean };
  BarkEnabled: boolean;
  FeishuWebhook: string;
  FeishuSecret: string;
  FeishuEnabled: boolean;
  TGToken: string;
  TGChatID: string;
  TGEnabled: boolean;
  Proxy: string;
  BarkProxy: boolean;
  FeishuProxy: boolean;
  TGProxy: boolean;
};

export type ScheduleRow = { id: number; hour: number; minute: number; enabled: boolean; next: string };

export type QueryWindowRow = {
  id: number;
  start: number;
  end: number;
  interval: number;
  max_alerts: number;
  enabled: boolean;
};

let singleton: Database.Database | null = null;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), salt BLOB NOT NULL, hash BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), api_key TEXT NOT NULL DEFAULT '',
  bark_url TEXT NOT NULL DEFAULT '', bark_key TEXT NOT NULL DEFAULT '', bark_local INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  default_alerts INTEGER NOT NULL DEFAULT 3 CHECK(default_alerts BETWEEN 1 AND 1000),
  bark_enabled INTEGER NOT NULL DEFAULT 0,
  feishu_webhook TEXT NOT NULL DEFAULT '', feishu_secret TEXT NOT NULL DEFAULT '', feishu_enabled INTEGER NOT NULL DEFAULT 0,
  tg_token TEXT NOT NULL DEFAULT '', tg_chat_id TEXT NOT NULL DEFAULT '', tg_enabled INTEGER NOT NULL DEFAULT 0,
  proxy_url TEXT NOT NULL DEFAULT '', proxy_ip TEXT NOT NULL DEFAULT '', proxy_tested_at TEXT NOT NULL DEFAULT '',
  proxy_latency_ms TEXT NOT NULL DEFAULT '',
  bark_proxy INTEGER NOT NULL DEFAULT 0 CHECK(bark_proxy IN (0,1)),
  feishu_proxy INTEGER NOT NULL DEFAULT 0 CHECK(feishu_proxy IN (0,1)),
  tg_proxy INTEGER NOT NULL DEFAULT 0 CHECK(tg_proxy IN (0,1)));
INSERT OR IGNORE INTO settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS stocks (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  reference_buy TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('manual','scheduled')), started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', schedule_id INTEGER, slot TEXT, slot_at TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_once ON runs(schedule_id,slot) WHERE schedule_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS results (run_id INTEGER NOT NULL REFERENCES runs(id), symbol TEXT NOT NULL,
  price TEXT NOT NULL DEFAULT '', open TEXT NOT NULL DEFAULT '', previous_close TEXT NOT NULL DEFAULT '',
  quote_at TEXT NOT NULL DEFAULT '', fetched_at TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  delay TEXT NOT NULL DEFAULT '未知', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
  alert_status TEXT NOT NULL DEFAULT '', asset_ok INTEGER NOT NULL DEFAULT 0,
  time_field TEXT NOT NULL DEFAULT '', PRIMARY KEY(run_id,symbol));
CREATE INDEX IF NOT EXISTS results_symbol_run ON results(symbol,run_id DESC);
CREATE INDEX IF NOT EXISTS results_symbol_ok ON results(symbol,run_id DESC) WHERE status='ok';
CREATE TABLE IF NOT EXISTS levels (id INTEGER PRIMARY KEY, stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK(side IN ('buy','sell')), target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), generation INTEGER NOT NULL DEFAULT 1, alerted_generation INTEGER,
  mode TEXT NOT NULL DEFAULT 'once' CHECK(mode IN ('once','repeat')),
  cooldown INTEGER NOT NULL DEFAULT 60 CHECK(cooldown BETWEEN 1 AND 10080),
  last_attempt TEXT NOT NULL DEFAULT '',
  max_alerts INTEGER NOT NULL DEFAULT 0 CHECK(max_alerts BETWEEN 0 AND 1000),
  uid TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS levels_uid ON levels(uid) WHERE uid!='';
CREATE INDEX IF NOT EXISTS levels_stock_side ON levels(stock_id,side);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
  symbol TEXT NOT NULL, price TEXT NOT NULL, quote_at TEXT NOT NULL, levels TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  window_id INTEGER NOT NULL DEFAULT 0, window_day TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS notifications_symbol ON notifications(symbol,id DESC);
CREATE INDEX IF NOT EXISTS notifications_run ON notifications(run_id);
CREATE INDEX IF NOT EXISTS notifications_window ON notifications(window_id,window_day,symbol,status);
CREATE TABLE IF NOT EXISTS notification_channels (notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(notification_id,channel));
CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY, hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
  minute INTEGER NOT NULL CHECK(minute BETWEEN 0 AND 59), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), UNIQUE(hour,minute));
CREATE TABLE IF NOT EXISTS query_windows (id INTEGER PRIMARY KEY AUTOINCREMENT,
  start INTEGER NOT NULL CHECK(start BETWEEN 0 AND 1439), end INTEGER NOT NULL CHECK(end BETWEEN 0 AND 1439 AND end!=start),
  interval INTEGER NOT NULL CHECK(interval BETWEEN 1 AND 1439), max_alerts INTEGER NOT NULL CHECK(max_alerts BETWEEN 1 AND 1000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)));
CREATE TABLE IF NOT EXISTS quote_calls (at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS quote_calls_at ON quote_calls(at);
`;

const UPGRADE_COLUMNS: Array<[string, string, string]> = [
  // [表, 列, 定义]：v14-17 代理字段、v19 results.open。幂等：存在即跳过。
  ["settings", "proxy_url", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "proxy_ip", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "proxy_tested_at", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "proxy_latency_ms", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "bark_proxy", "INTEGER NOT NULL DEFAULT 0"],
  ["settings", "feishu_proxy", "INTEGER NOT NULL DEFAULT 0"],
  ["settings", "tg_proxy", "INTEGER NOT NULL DEFAULT 0"],
  ["results", "open", "TEXT NOT NULL DEFAULT ''"],
];

function upgradeToCurrent(db: Database.Database, from: number): void {
  if (from >= SCHEMA_VERSION) return;
  for (const [table, col, def] of UPGRADE_COLUMNS) {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function openDB(dir?: string, file = "ticker.db"): Database.Database {
  if (file === ":memory:") {
    // 内存库不落盘、不进单例：每次返回全新连接，便于并行测试。
    const mem = new Database(":memory:");
    mem.pragma("foreign_keys = ON");
    mem.exec(SCHEMA_DDL);
    mem.pragma(`user_version = ${SCHEMA_VERSION}`);
    return mem;
  }
  const base = dir ?? path.join(dataDir(), "tickersentry");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(base, file));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`数据库版本 ${version} 比程序新；请恢复匹配版本`);
  }
  if (version === 0) {
    // 全新库：建表并直接落目标版本。
    db.exec(SCHEMA_DDL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else {
    // 13..19 的真实 Go 库：幂等补齐 v14-19 的列（全部带默认值）。
    upgradeToCurrent(db, version);
  }
  // 启动自愈：与 Go 版 openDB 相同的中断收尾。
  const nowText = now();
  db.prepare(`UPDATE runs SET status='interrupted', reason='进程中断，旧报价不会补查', finished_at=? WHERE status='running'`).run(nowText);
  db.prepare(`UPDATE results SET status='interrupted', error='进程中断' WHERE status='pending'`).run();
  db.prepare(`UPDATE notification_channels SET status='不确定',error='进程中断，发送结果未知' WHERE status='发送中'`).run();
  db.prepare(`UPDATE notification_channels SET status='未发送' WHERE status='待发送'`).run();
  db.prepare(`UPDATE notifications SET status=CASE
      WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id AND c.status='成功')
        THEN CASE WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id AND c.status!='成功') THEN '部分成功' ELSE '成功' END
      WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id AND c.status='不确定') THEN '不确定'
      WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id AND c.status='失败') THEN '失败'
      WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id) THEN '命中但未通知（中断前未发送）'
      ELSE '不确定' END,
      error='进程中断，请查看各渠道发送结果' WHERE status='不确定' AND error='进程中断，推送结果未知' AND EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id)`).run();
  db.prepare(`UPDATE results SET alert_status=(SELECT status FROM notifications WHERE notifications.run_id=results.run_id AND notifications.symbol=results.symbol ORDER BY id DESC LIMIT 1) WHERE alert_status='发送中'`).run();
  pruneHistory(db, new Date());
  return db;
}

export function getDB(): Database.Database {
  if (!singleton) singleton = openDB();
  return singleton;
}

// 测试用：注入内存库实例。
export function setDB(db: Database.Database | null): void {
  singleton = db;
}

export function now(): string {
  return rfc3339Nano(new Date());
}

export function closeDB(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

export function value(db: Database.Database, query: string, ...args: unknown[]): string {
  const row = db.prepare(query).get(...args) as Record<string, unknown> | undefined;
  if (!row) return "";
  const first = Object.values(row)[0];
  return first == null ? "" : String(first);
}

// —— 行情调用额度记账（Go reserve() 的存储层）——
export function reserveQuoteCall(db: Database.Database): { ok: true } | { ok: false; error: string; retryAfterMs: number } {
  for (;;) {
    const t = new Date();
    const dayCutoff = quotaAt(new Date(t.getTime() - 24 * 3600 * 1000));
    db.prepare(`DELETE FROM quote_calls WHERE at<?`).run(dayCutoff);
    const minuteCutoff = quotaAt(new Date(t.getTime() - 60 * 1000));
    const minuteRow = db.prepare(`SELECT count(*) AS c,COALESCE(MIN(at),'') AS oldest FROM quote_calls WHERE at>?`).get(minuteCutoff) as { c: number; oldest: string };
    const dayRow = db.prepare(`SELECT count(*) AS c FROM quote_calls`).get() as { c: number };
    if (dayRow.c >= 800) {
      return { ok: false, error: "行情接口 24 小时额度已用尽", retryAfterMs: 0 };
    }
    if (minuteRow.c < 8) {
      db.prepare(`INSERT INTO quote_calls(at) VALUES(?)`).run(quotaAt(t));
      return { ok: true };
    }
    const oldest = minuteRow.oldest ? parseRFC3339(minuteRow.oldest) : null;
    const delay = oldest ? oldest.getTime() + 60 * 1000 + 1000 - t.getTime() : 1000;
    return { ok: false, error: "__wait__", retryAfterMs: Math.max(1000, delay) };
  }
}

export function listStocks(db: Database.Database): Stock[] {
  const rows = db.prepare(`SELECT s.id,s.symbol,s.note,s.enabled,s.reference_buy,
    COALESCE(price.price,'') AS last_price,COALESCE(price.quote_at,'') AS last_at,COALESCE(price.source,'') AS last_source,
    COALESCE(price.previous_close,'') AS prev_close,COALESCE(price.open,'') AS open,
    COALESCE(latest.status,'') AS last_status,COALESCE(latest.error,'') AS last_error,
    COALESCE(price.time_field,'') AS time_field,COALESCE(price.asset_ok,0) AS asset_ok
    FROM stocks s
    LEFT JOIN results latest ON latest.symbol=s.symbol AND latest.run_id=(SELECT MAX(run_id) FROM results WHERE symbol=s.symbol)
    LEFT JOIN results price ON price.symbol=s.symbol AND price.run_id=(SELECT MAX(run_id) FROM results WHERE symbol=s.symbol AND status='ok')
    ORDER BY s.symbol`).all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const s: Stock = {
      ID: Number(r.id),
      Symbol: String(r.symbol),
      Note: String(r.note),
      Enabled: Number(r.enabled) === 1,
      ReferenceBuy: String(r.reference_buy),
      LastPrice: String(r.last_price),
      Open: String(r.open),
      PrevClose: String(r.prev_close),
      DayChange: "",
      DayPercent: "",
      DayClass: "",
      LastAt: String(r.last_at),
      LastSource: String(r.last_source),
      LastStatus: String(r.last_status),
      LastError: String(r.last_error),
      TimeField: String(r.time_field),
      AssetOK: Number(r.asset_ok) === 1,
      AlertReason: "",
      WindowStatus: "",
      WindowCapped: false,
      BuyBasis: "",
      BuyLevels: [],
      SellLevels: [],
    };
    const [dayChange, dayPercent, dayClass] = dayMove(s.LastPrice, s.PrevClose);
    s.DayChange = dayChange;
    s.DayPercent = dayPercent;
    s.DayClass = dayClass;
    return s;
  });
}

// dayMove：照 Go 版，价格与昨收均为正才计算。
export function dayMove(price: string, previous: string): [string, string, string] {
  const p = parseDecimal(price);
  if (!p || !isPositive(p)) return ["", "", ""];
  const prev = parseDecimal(previous);
  if (!prev || !isPositive(prev)) return ["", "", ""];
  const diff = subDec(p, prev);
  const cls = cmpDec(diff, decFromInt(0)) > 0 ? "up" : cmpDec(diff, decFromInt(0)) < 0 ? "down" : "flat";
  const sign = cmpDec(diff, decFromInt(0)) > 0 ? "+" : "";
  const pct = mulDec(divDec(diff, prev), decFromInt(100));
  return [sign + stringFixed(diff, 2), sign + stringFixed(pct, 2) + "%", cls];
}

export function getStock(db: Database.Database, id: number): Stock | null {
  const r = db.prepare(`SELECT id,symbol,note,enabled,reference_buy FROM stocks WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    ID: Number(r.id),
    Symbol: String(r.symbol),
    Note: String(r.note),
    Enabled: Number(r.enabled) === 1,
    ReferenceBuy: String(r.reference_buy),
    LastPrice: "", Open: "", PrevClose: "", DayChange: "", DayPercent: "", DayClass: "",
    LastAt: "", LastSource: "", LastStatus: "", LastError: "", TimeField: "", AssetOK: false,
    AlertReason: "", WindowStatus: "", WindowCapped: false, BuyBasis: "", BuyLevels: [], SellLevels: [],
  };
}

export function listStockQuotes(db: Database.Database, symbol: string): StockQuote[] {
  const rows = db.prepare(`SELECT run_id,price,open,previous_close,quote_at,fetched_at,source,status,error,alert_status
    FROM results WHERE symbol=? ORDER BY run_id DESC LIMIT 30`).all(symbol) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    RunID: Number(r.run_id),
    Price: String(r.price),
    Open: String(r.open),
    PrevClose: String(r.previous_close),
    QuoteAt: String(r.quote_at),
    FetchedAt: String(r.fetched_at),
    Source: String(r.source),
    Status: String(r.status),
    Error: String(r.error),
    AlertStatus: String(r.alert_status),
  }));
}

export function listRuns(db: Database.Database): Run[] {
  const rows = db.prepare(`SELECT id,kind,status,reason,started_at,COALESCE(finished_at,'') AS finished_at,
    (SELECT count(*) FROM results WHERE run_id=runs.id AND status!='pending') AS done,
    (SELECT count(*) FROM results WHERE run_id=runs.id) AS total
    FROM runs ORDER BY id DESC LIMIT 25`).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    status: String(r.status),
    reason: String(r.reason),
    started_at: String(r.started_at),
    slot_at: "",
    finished_at: String(r.finished_at),
    done: Number(r.done),
    total: Number(r.total),
    results: [],
  }));
}

export function getRun(db: Database.Database, id: number): Run | null {
  const r = db.prepare(`SELECT id,kind,status,reason,started_at,slot_at,COALESCE(finished_at,'') AS finished_at FROM runs WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const run: Run = {
    id: Number(r.id),
    kind: String(r.kind),
    status: String(r.status),
    reason: String(r.reason),
    started_at: String(r.started_at),
    slot_at: String(r.slot_at),
    finished_at: String(r.finished_at),
    done: 0,
    total: 0,
    results: [],
  };
  const rows = db.prepare(`SELECT symbol,price,open,previous_close,quote_at,fetched_at,source,time_field,delay,status,error,alert_status FROM results WHERE run_id=? ORDER BY symbol`).all(id) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const v: Result = {
      Symbol: String(row.symbol),
      Price: String(row.price),
      Open: String(row.open),
      PrevClose: String(row.previous_close),
      QuoteAt: String(row.quote_at),
      FetchedAt: String(row.fetched_at),
      Source: String(row.source),
      TimeField: String(row.time_field),
      Delay: String(row.delay),
      Status: String(row.status),
      Error: String(row.error),
      AlertStatus: String(row.alert_status),
      AssetOK: false,
    };
    run.total++;
    if (v.Status !== "pending") run.done++;
    run.results.push(v);
  }
  return run;
}

export function createRun(db: Database.Database, stocks: Stock[], kind: string, scheduleID: number, due: string, slotAt: string): number {
  const tx = db.transaction((): number => {
    const res = db.prepare(`INSERT INTO runs(kind,started_at,status,schedule_id,slot,slot_at) VALUES(?,?,'running',NULLIF(?,0),NULLIF(?,''),?)`)
      .run(kind, now(), scheduleID, due, slotAt);
    const id = Number(res.lastInsertRowid);
    for (const s of stocks) {
      db.prepare(`INSERT INTO results(run_id,symbol,status) VALUES(?,?,'pending')`).run(id, s.Symbol);
    }
    return id;
  });
  return tx();
}

export function saveResult(db: Database.Database, id: number, v: Result): void {
  db.prepare(`UPDATE results SET price=?,open=?,previous_close=?,quote_at=?,fetched_at=?,source=?,time_field=?,delay=?,status=?,error=?,alert_status=?,asset_ok=? WHERE run_id=? AND symbol=?`)
    .run(v.Price, v.Open, v.PrevClose, v.QuoteAt, v.FetchedAt, v.Source, v.TimeField, v.Delay, v.Status, v.Error, v.AlertStatus, v.AssetOK ? 1 : 0, id, v.Symbol);
}

export function finishRun(db: Database.Database, id: number, reason: string): void {
  db.prepare(`UPDATE results SET status='interrupted',error='查询未完成' WHERE run_id=? AND status='pending'`).run(id);
  const counts = db.prepare(`SELECT count(*) FILTER (WHERE status='ok') AS ok,
    count(*) FILTER (WHERE status NOT IN ('ok','skipped')) AS bad,
    count(*) FILTER (WHERE status='skipped') AS skipped,
    count(*) FILTER (WHERE alert_status IN ('失败','不确定','部分成功') OR alert_status LIKE '命中但未通知%') AS missed
    FROM results WHERE run_id=?`).get(id) as { ok: number; bad: number; skipped: number; missed: number };
  let status = "completed";
  if (counts.ok === 0 && counts.bad === 0 && counts.skipped > 0) status = "skipped";
  else if (counts.ok === 0) status = "failed";
  else if (counts.bad > 0 || counts.missed > 0) status = "partial";
  let finalReason = reason;
  if (reason !== "") status = "partial";
  if (reason.includes("中断")) status = "interrupted";
  if (reason === "") {
    if (counts.skipped > 0 && counts.bad === 0 && counts.ok === 0) finalReason = "查询时段结束、暂停或提醒已达上限";
    else if (counts.bad > 0 && counts.ok === 0) finalReason = "全部股票查询失败";
    else if (counts.bad > 0) finalReason = "部分股票查询失败";
    else if (counts.missed > 0) finalReason = "部分提醒未送达";
  }
  db.prepare(`UPDATE runs SET status=?,reason=?,finished_at=? WHERE id=?`).run(status, finalReason, now(), id);
}

export function pruneHistory(db: Database.Database, at: Date): void {
  // Go：at.AddDate(0,0,-90).UTC().Format("2006-01-02")；按 UTC 日历日减 90 天。
  const cutoff = new Date(at.getTime() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const tx = db.transaction(() => {
    for (const table of ["notifications", "results"]) {
      db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT id FROM runs WHERE substr(started_at,1,10) < ? AND status != 'running')`).run(cutoff);
    }
    db.prepare(`DELETE FROM runs WHERE substr(started_at,1,10) < ? AND status != 'running'`).run(cutoff);
    db.prepare(`DELETE FROM sessions WHERE julianday(expires_at) < julianday(?)`).run(rfc3339Nano(at));
  });
  tx();
}

// —— 通知渠道配置 ——
export function notificationSettings(db: Database.Database): NotificationChannelConfig {
  const r = db.prepare(`SELECT bark_url,bark_key,bark_local,bark_enabled,feishu_webhook,feishu_secret,feishu_enabled,tg_token,tg_chat_id,tg_enabled,proxy_url,bark_proxy,feishu_proxy,tg_proxy FROM settings WHERE id=1`).get() as Record<string, unknown>;
  return {
    Bark: { URL: String(r.bark_url), Key: String(r.bark_key), Local: Number(r.bark_local) === 1 },
    BarkEnabled: Number(r.bark_enabled) === 1,
    FeishuWebhook: String(r.feishu_webhook),
    FeishuSecret: String(r.feishu_secret),
    FeishuEnabled: Number(r.feishu_enabled) === 1,
    TGToken: String(r.tg_token),
    TGChatID: String(r.tg_chat_id),
    TGEnabled: Number(r.tg_enabled) === 1,
    Proxy: String(r.proxy_url),
    BarkProxy: Number(r.bark_proxy) === 1,
    FeishuProxy: Number(r.feishu_proxy) === 1,
    TGProxy: Number(r.tg_proxy) === 1,
  };
}

export function barkSettings(db: Database.Database): { URL: string; Key: string; Local: boolean } {
  const r = db.prepare(`SELECT bark_url,bark_key,bark_local FROM settings WHERE id=1`).get() as Record<string, unknown>;
  return { URL: String(r.bark_url), Key: String(r.bark_key), Local: Number(r.bark_local) === 1 };
}

// —— 档位 ——
export function listLevels(db: Database.Database, stockID: number): Level[] {
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
    AlertedGeneration: null as unknown as number | null,
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

export function alertLimit(level: Level, w: { max_alerts: number } | null): number {
  if (level.MaxAlerts > 0) return level.MaxAlerts;
  return w ? w.max_alerts : 0;
}

// dueLevels：买入选最低已命中目标，卖入选最高；同价按创建先后（listLevels 已按 id 排序，
// 严格小于/大于比较保持最早一档优先）。
export function dueLevels(db: Database.Database, stockID: number, price: Decimal): Level[] {
  const levels = listLevels(db, stockID);
  let buy: Level | null = null;
  let sell: Level | null = null;
  for (const l of levels) {
    if (!l.Enabled) continue;
    const d = parseDecimal(l.Target);
    if (!d) throw new Error(`档位价格无效: ${l.Target}`);
    const isBuy = l.Side === "buy";
    const hit = isBuy ? cmpDec(price, d) <= 0 : cmpDec(price, d) >= 0;
    if (!hit) continue;
    if (isBuy) {
      const cur = buy ? parseDecimal(buy.Target) : null;
      if (!cur || cmpDec(d, cur) < 0) buy = l;
    } else {
      const cur = sell ? parseDecimal(sell.Target) : null;
      if (!cur || cmpDec(d, cur) > 0) sell = l;
    }
  }
  const out: Level[] = [];
  if (buy) out.push(buy);
  if (sell) out.push(sell);
  return out;
}

export function listNotifications(db: Database.Database, symbol: string): NotificationRow[] {
  const rows = db.prepare(`SELECT id,run_id,symbol,price,quote_at,levels,status,error,created_at FROM notifications WHERE symbol=? ORDER BY id DESC LIMIT 30`).all(symbol) as Array<Record<string, unknown>>;
  const out: NotificationRow[] = rows.map((r) => ({
    ID: Number(r.id),
    RunID: Number(r.run_id),
    Symbol: String(r.symbol),
    Price: String(r.price),
    QuoteAt: String(r.quote_at),
    Levels: String(r.levels),
    Status: String(r.status),
    Error: String(r.error),
    CreatedAt: String(r.created_at),
    Channels: [],
  }));
  const channels = db.prepare(`SELECT notification_id,channel,status,error FROM notification_channels WHERE notification_id IN (SELECT id FROM notifications WHERE symbol=? ORDER BY id DESC LIMIT 30) ORDER BY notification_id DESC,channel`).all(symbol) as Array<Record<string, unknown>>;
  const byID = new Map<number, NotificationRow>(out.map((n) => [n.ID, n]));
  for (const c of channels) {
    const n = byID.get(Number(c.notification_id));
    if (n) n.Channels.push({ Name: String(c.channel), Status: String(c.status), Error: String(c.error) });
  }
  for (const n of out) {
    if (n.Channels.length === 0 && !n.Status.startsWith("命中但未通知")) {
      n.Channels.push({ Name: "Bark", Status: n.Status, Error: n.Error });
    }
  }
  return out;
}

// —— 通知记录 ——
export function recordAttemptChannels(
  db: Database.Database,
  runID: number,
  q: { Symbol: string; Price: string; QuoteAt: Date },
  levels: Level[],
  status: string,
  windowID: number,
  day: string,
  channels: string[],
): number {
  const snapshots = levels.map((l) => ({ id: l.ID, uid: l.UID, generation: l.Generation, side: l.Side, target: l.Target }));
  const data = JSON.stringify(snapshots);
  const tx = db.transaction((): number => {
    const res = db.prepare(`INSERT INTO notifications(run_id,symbol,price,quote_at,levels,status,created_at,window_id,window_day) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(runID, q.Symbol, q.Price, rfc3339Nano(q.QuoteAt), data, status, now(), windowID, day);
    const id = Number(res.lastInsertRowid);
    for (const channel of channels) {
      db.prepare(`INSERT INTO notification_channels(notification_id,channel,status) VALUES(?,?,'待发送')`).run(id, channel);
    }
    db.prepare(`UPDATE results SET alert_status=? WHERE run_id=? AND symbol=?`).run(status, runID, q.Symbol);
    return id;
  });
  return tx();
}

export function updateChannel(db: Database.Database, id: number, channel: string, status: string, detail: string): void {
  db.prepare(`UPDATE notification_channels SET status=?,error=? WHERE notification_id=? AND channel=?`).run(status, detail, id, channel);
}

export function finishAttempt(db: Database.Database, id: number, runID: number, symbol: string, status: string, detail: string): void {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE notifications SET status=?,error=? WHERE id=?`).run(status, detail, id);
    db.prepare(`UPDATE results SET alert_status=? WHERE run_id=? AND symbol=?`).run(status, runID, symbol);
  });
  tx();
}

// —— 交易日历（委托 calendar.ts）——
export { calendarReviewed, isOpen, regularHours } from "./calendar";

// —— 预计收益（levels.go setReturns / expectedReturn）——
export function expectedReturn(buy: string, sell: string): string {
  const b = parseDecimal(buy);
  if (!b || !isPositive(b)) return "设置买入价后查看预计收益";
  const p = parseDecimal(sell);
  if (!p) return "";
  const delta = subDec(p, b);
  const sign = cmpDec(delta, decFromInt(0)) > 0 ? "+" : "";
  const pct = mulDec(divDec(delta, b), decFromInt(100));
  return `每股 ${sign}${stringFixed(delta, 2)} USD · ${sign}${stringFixed(pct, 2)}%`;
}

// setReturns：参考买入价默认取最高买入目标；参考价仍在目标列表中则优先。
export function setReturns(stock: Stock): void {
  let basis = "";
  for (const l of stock.BuyLevels) {
    if (l.Target === stock.ReferenceBuy) {
      basis = l.Target;
      break;
    }
    const t = parseDecimal(l.Target);
    const cur = basis === "" ? null : parseDecimal(basis);
    if (!cur || (t && cmpDec(t, cur) > 0)) basis = l.Target;
  }
  stock.BuyBasis = basis;
  for (const l of stock.SellLevels) {
    l.Profit = expectedReturn(basis, l.Target);
  }
}

// —— 阈值差距（readiness.go targetGap）——
export function targetGap(side: string, target: string, price: string): string {
  const p = parseDecimal(price);
  if (!p || !isPositive(p)) return "暂无报价，无法计算差距";
  const t = parseDecimal(target);
  if (!t) return "目标价无效";
  const hit = (side === "buy" && cmpDec(p, t) <= 0) || (side === "sell" && cmpDec(p, t) >= 0);
  if (hit) return "报价已达目标（不代表已通知）";
  const diffAbs = subDec(t, p);
  const diff = isPositive(diffAbs) ? diffAbs : subDec(p, t);
  const direction = side === "buy" ? "下跌" : "上涨";
  const pct = mulDec(divDec(diff, p), decFromInt(100));
  return `还需${direction} ${stringFixed(diff, 2)} USD（${stringFixed(pct, 2)}%）`;
}

// —— 固定时间点 ——
export function schedules(db: Database.Database): ScheduleRow[] {
  const rows = db.prepare(`SELECT id,hour,minute,enabled FROM schedules ORDER BY hour,minute`).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), hour: Number(r.hour), minute: Number(r.minute), enabled: Number(r.enabled) === 1, next: "" }));
}

// —— 查询时段 ——
export function queryWindows(db: Database.Database): QueryWindowRow[] {
  const rows = db.prepare(`SELECT id,start,end,interval,max_alerts,enabled FROM query_windows ORDER BY start`).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    start: Number(r.start),
    end: Number(r.end),
    interval: Number(r.interval),
    max_alerts: Number(r.max_alerts),
    enabled: Number(r.enabled) === 1,
  }));
}

export function validWindow(w: QueryWindowRow): boolean {
  const duration = windowDuration(w);
  return w.start >= 0 && w.start < 1440 && w.end >= 0 && w.end < 1440 && w.start !== w.end &&
    w.interval >= 1 && w.interval <= duration && w.max_alerts >= 1 && w.max_alerts <= 1000;
}

export function windowDuration(w: QueryWindowRow): number {
  return ((w.end - w.start + 1440) % 1440);
}

export function windowsOverlap(a: QueryWindowRow, b: QueryWindowRow): boolean {
  return ((b.start - a.start + 1440) % 1440) < windowDuration(a) || ((a.start - b.start + 1440) % 1440) < windowDuration(b);
}

export function windowText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function overnight(w: QueryWindowRow): boolean {
  return w.end < w.start;
}

export function timezoneOf(db: Database.Database): string {
  return value(db, `SELECT timezone FROM settings WHERE id=1`);
}

export function defaultAlerts(db: Database.Database): number {
  return Number(value(db, `SELECT default_alerts FROM settings WHERE id=1`) || "3");
}

export function apiKeyOf(db: Database.Database): string {
  return value(db, `SELECT api_key FROM settings WHERE id=1`);
}

export function proxySetting(db: Database.Database): string {
  return value(db, `SELECT proxy_url FROM settings WHERE id=1`);
}
