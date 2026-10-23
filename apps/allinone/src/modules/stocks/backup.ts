// 配置备份（config_backup.go + backup.go）：
// - JSON 配置备份导出/导入：兼容导入版本 1–4（任务约束版本 5；Go 当前导出 Format=Version 7，
//   这里按任务约束固定导出 Version 5 并接受 1–7 导入，字段映射照 Go validateConfig 的兼容规则）。
// - 完整库在线备份：better-sqlite3 的 .backup()（等价 SQLite 在线一致性快照，含 WAL 已提交数据）。

import type { Database } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { checkBarkURL, checkFeishuWebhook, checkProxy, checkTG } from "./notify";
import { now, queryWindows, validWindow, windowsOverlap } from "./store";
import { parseTarget, SYMBOL_RE } from "./levels";

export const BACKUP_LIMIT = 2 << 20; // 2 MiB

export type BackupLevel = {
  side: string;
  target: string;
  note: string;
  mode: string;
  cooldown: number;
  max_alerts: number;
  enabled: boolean;
  alerted: boolean;
  last_attempt: string;
};

export type BackupStock = {
  symbol: string;
  note: string;
  reference_buy: string;
  enabled: boolean;
  levels: BackupLevel[];
};

export type BackupSchedule = { hour: number; minute: number; enabled: boolean };

export type BackupWindow = {
  id: number;
  start: number;
  end: number;
  interval: number;
  max_alerts: number;
  enabled: boolean;
};

export type ConfigBackup = {
  format: string;
  version: number;
  created_at: string;
  settings: {
    api_key: string;
    bark_url: string;
    bark_key: string;
    bark_local: boolean;
    bark_enabled: boolean;
    feishu_webhook: string;
    feishu_secret: string;
    feishu_enabled: boolean;
    tg_token: string;
    tg_chat_id: string;
    tg_enabled: boolean;
    timezone: string;
    default_alerts: number;
    proxy_url: string;
    bark_proxy: boolean;
    feishu_proxy: boolean;
    tg_proxy: boolean;
  };
  stocks: BackupStock[];
  schedules: BackupSchedule[];
  windows: BackupWindow[];
};

export function exportConfig(db: Database): ConfigBackup {
  const s = db.prepare(`SELECT api_key,bark_url,bark_key,bark_local,bark_enabled,feishu_webhook,feishu_secret,feishu_enabled,
    tg_token,tg_chat_id,tg_enabled,timezone,default_alerts,proxy_url,bark_proxy,feishu_proxy,tg_proxy FROM settings WHERE id=1`).get() as Record<string, unknown>;
  const stocks: BackupStock[] = [];
  const ids = new Map<number, number>();
  const stockRows = db.prepare(`SELECT id,symbol,note,enabled,reference_buy FROM stocks ORDER BY symbol`).all() as Array<Record<string, unknown>>;
  for (const r of stockRows) {
    const id = Number(r.id);
    ids.set(id, stocks.length);
    stocks.push({
      symbol: String(r.symbol),
      note: String(r.note),
      reference_buy: String(r.reference_buy),
      enabled: Number(r.enabled) === 1,
      levels: [],
    });
  }
  const levelRows = db.prepare(`SELECT stock_id,side,target,note,mode,cooldown,enabled,COALESCE(alerted_generation=generation,0) AS alerted,last_attempt,max_alerts FROM levels ORDER BY id`).all() as Array<Record<string, unknown>>;
  for (const r of levelRows) {
    const stockID = Number(r.stock_id);
    const idx = ids.get(stockID);
    if (idx === undefined) throw new Error("档位所属股票不存在");
    stocks[idx].levels.push({
      side: String(r.side),
      target: String(r.target),
      note: String(r.note),
      mode: String(r.mode),
      cooldown: Number(r.cooldown),
      enabled: Number(r.enabled) === 1,
      alerted: Number(r.alerted) === 1,
      last_attempt: String(r.last_attempt),
      max_alerts: Number(r.max_alerts),
    });
  }
  const schedules: BackupSchedule[] = (db.prepare(`SELECT hour,minute,enabled FROM schedules ORDER BY hour,minute`).all() as Array<Record<string, unknown>>).map((r) => ({
    hour: Number(r.hour),
    minute: Number(r.minute),
    enabled: Number(r.enabled) === 1,
  }));
  const windows: BackupWindow[] = queryWindows(db).map((w) => ({
    id: w.id,
    start: w.start,
    end: w.end,
    interval: w.interval,
    max_alerts: w.max_alerts,
    enabled: w.enabled,
  }));
  return {
    format: "TickerSentry",
    version: 5,
    created_at: now(),
    settings: {
      api_key: String(s.api_key),
      bark_url: String(s.bark_url),
      bark_key: String(s.bark_key),
      bark_local: Number(s.bark_local) === 1,
      bark_enabled: Number(s.bark_enabled) === 1,
      feishu_webhook: String(s.feishu_webhook),
      feishu_secret: String(s.feishu_secret),
      feishu_enabled: Number(s.feishu_enabled) === 1,
      tg_token: String(s.tg_token),
      tg_chat_id: String(s.tg_chat_id),
      tg_enabled: Number(s.tg_enabled) === 1,
      timezone: String(s.timezone),
      default_alerts: Number(s.default_alerts),
      proxy_url: String(s.proxy_url),
      bark_proxy: Number(s.bark_proxy) === 1,
      feishu_proxy: Number(s.feishu_proxy) === 1,
      tg_proxy: Number(s.tg_proxy) === 1,
    },
    stocks,
    schedules,
    windows,
  };
}

export function validateConfig(b: ConfigBackup): void {
  if (b.format !== "TickerSentry" || b.version < 1 || b.version > 7) {
    throw new Error("不是支持的 TickerSentry 配置备份（版本 1 至 7）");
  }
  const s = b.settings;
  if (s.proxy_url) {
    s.proxy_url = checkProxy(s.proxy_url);
  }
  if (b.version < 7) {
    s.feishu_proxy = s.proxy_url !== "";
    s.tg_proxy = s.proxy_url !== "";
  }
  if (s.proxy_url === "" && (s.bark_proxy || s.feishu_proxy || s.tg_proxy)) {
    throw new Error("备份中通知渠道选择了代理，但未配置代理地址");
  }
  if (b.version < 4) {
    s.default_alerts = 3;
  }
  if (b.version < 5) {
    s.bark_enabled = s.bark_url !== "" && s.bark_key !== "";
  }
  if (s.default_alerts < 1 || s.default_alerts > 1000) {
    throw new Error("备份默认提醒上限无效");
  }
  if (s.timezone !== "Asia/Shanghai" && s.timezone !== "America/New_York") {
    throw new Error("备份时区无效");
  }
  if (s.api_key.length > 256 || s.bark_key.length > 256) {
    throw new Error("备份中的 Key 过长");
  }
  if (s.bark_url !== "") {
    s.bark_url = checkBarkURL(s.bark_url, s.bark_local);
  }
  if (s.bark_enabled && (s.bark_url === "" || s.bark_key === "")) {
    throw new Error("备份中的 Bark 配置不完整");
  }
  if (s.feishu_webhook !== "") {
    s.feishu_webhook = checkFeishuWebhook(s.feishu_webhook);
  }
  if (s.feishu_secret.length > 256 || (s.feishu_enabled && s.feishu_webhook === "")) {
    throw new Error("备份中的飞书配置无效");
  }
  if (s.tg_token !== "" || s.tg_chat_id !== "") {
    checkTG(s.tg_token, s.tg_chat_id);
  }
  if (s.tg_enabled && (s.tg_token === "" || s.tg_chat_id === "")) {
    throw new Error("备份中的 Telegram 配置不完整");
  }
  if (b.stocks.length > 1000 || b.schedules.length > 1440) {
    throw new Error("备份配置数量过多");
  }
  const seen = new Set<string>();
  let total = 0;
  for (const stock of b.stocks) {
    if (!SYMBOL_RE.test(stock.symbol) || seen.has(stock.symbol) || stock.note.length > 200) {
      throw new Error("备份股票代码重复、无效或备注过长");
    }
    if (stock.reference_buy !== "") {
      stock.reference_buy = parseTarget(stock.reference_buy);
    }
    seen.add(stock.symbol);
    total += stock.levels.length;
    if (total > 10000) throw new Error("备份档位过多");
    for (const l of stock.levels) {
      l.target = parseTarget(l.target);
      if (
        (l.side !== "buy" && l.side !== "sell") ||
        (l.mode !== "once" && l.mode !== "repeat") ||
        l.cooldown < 1 ||
        l.cooldown > 10080 ||
        l.max_alerts < 0 ||
        l.max_alerts > 1000 ||
        l.note.length > 200
      ) {
        throw new Error("备份档位的方向、模式、冷却时间、提醒上限或备注无效");
      }
      if (l.last_attempt !== "") {
        const at = new Date(l.last_attempt);
        if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 2 * 60 * 1000) {
          throw new Error("备份提醒时间无效或在未来");
        }
      }
    }
  }
  if (b.windows.length > 1440) throw new Error("备份查询时段过多");
  for (let i = 0; i < b.windows.length; i++) {
    const w = b.windows[i];
    if (w.id <= 0 || !validWindow(w)) throw new Error("备份查询时段无效");
    for (const other of b.windows.slice(0, i)) {
      if (w.id === other.id || windowsOverlap(w, other)) {
        throw new Error("备份查询时段重复或重叠");
      }
    }
  }
  const slots = new Set<number>();
  for (const sch of b.schedules) {
    const slot = sch.hour * 60 + sch.minute;
    if (sch.hour < 0 || sch.hour > 23 || sch.minute < 0 || sch.minute > 59 || slots.has(slot)) {
      throw new Error("备份查询时间无效或重复");
    }
    slots.add(slot);
  }
}

export function importConfig(db: Database, b: ConfigBackup, proxyLatency: string, testedAt: string): void {
  const tx = db.transaction(() => {
    for (const query of [`DELETE FROM levels`, `DELETE FROM stocks`, `DELETE FROM schedules`, `DELETE FROM query_windows`]) {
      db.prepare(query).run();
    }
    const s = b.settings;
    db.prepare(`UPDATE settings SET api_key=?,bark_url=?,bark_key=?,bark_local=?,bark_enabled=?,feishu_webhook=?,feishu_secret=?,feishu_enabled=?,tg_token=?,tg_chat_id=?,tg_enabled=?,timezone=?,default_alerts=?,proxy_url=?,proxy_latency_ms=?,proxy_tested_at=?,bark_proxy=?,feishu_proxy=?,tg_proxy=? WHERE id=1`)
      .run(s.api_key, s.bark_url, s.bark_key, s.bark_local ? 1 : 0, s.bark_enabled ? 1 : 0, s.feishu_webhook, s.feishu_secret, s.feishu_enabled ? 1 : 0, s.tg_token, s.tg_chat_id, s.tg_enabled ? 1 : 0, s.timezone, s.default_alerts, s.proxy_url, proxyLatency, testedAt, s.bark_proxy ? 1 : 0, s.feishu_proxy ? 1 : 0, s.tg_proxy ? 1 : 0);
    for (const stock of b.stocks) {
      const res = db.prepare(`INSERT INTO stocks(symbol,note,enabled,reference_buy) VALUES(?,?,?,?)`)
        .run(stock.symbol, stock.note, stock.enabled ? 1 : 0, stock.reference_buy);
      const id = Number(res.lastInsertRowid);
      for (const l of stock.levels) {
        db.prepare(`INSERT INTO levels(stock_id,side,target,note,mode,cooldown,enabled,alerted_generation,last_attempt,max_alerts,uid) VALUES(?,?,?,?,?,?,?,?,?,?,lower(hex(randomblob(16))))`)
          .run(id, l.side, l.target, l.note, l.mode, l.cooldown, l.enabled ? 1 : 0, l.alerted ? 1 : null, l.last_attempt, l.max_alerts);
      }
    }
    for (const sch of b.schedules) {
      db.prepare(`INSERT INTO schedules(hour,minute,enabled) VALUES(?,?,?)`).run(sch.hour, sch.minute, sch.enabled ? 1 : 0);
    }
    for (const w of b.windows) {
      db.prepare(`INSERT INTO query_windows(id,start,end,interval,max_alerts,enabled) VALUES(?,?,?,?,?,?)`)
        .run(w.id, w.start, w.end, w.interval, w.max_alerts, w.enabled ? 1 : 0);
    }
  });
  tx();
}

// 完整库在线备份（better-sqlite3 .backup()，等价 Go 版 VACUUM INTO 的一致性快照）。
export async function backupDatabase(dir: string, dest: string): Promise<void> {
  const src = path.resolve(path.join(dir, "ticker.db"));
  const target = path.resolve(dest);
  if (src === target) throw new Error("备份路径不能是活动数据库");
  if (!fs.existsSync(src)) throw new Error("源数据库不可用");
  if (fs.existsSync(target)) throw new Error("备份文件已存在");
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(src);
  try {
    db.pragma("busy_timeout = 5000");
    await db.backup(target);
  } finally {
    db.close();
  }
  fs.chmodSync(target, 0o600);
}
