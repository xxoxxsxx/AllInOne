// 查询时段：跨午夜、起点执行终点不执行、按起点对齐间隔（windows.go 语义）。
// 额度计数：notifications 表（发送中/成功/部分成功/不确定）按档位 uid 统计。

import type { Database } from "better-sqlite3";

import { alertLimit, listLevels, queryWindows, validWindow, value, windowDuration, windowsOverlap } from "./store";
import type { Level, QueryWindowRow } from "./store";
import { parseClock, zonedParts, type StockTimezone } from "./tz";

export { validWindow };

export type Occurrence = { day: string; offset: number; active: boolean };

// occurrence：返回 at 所在时区当天相对时段起点的偏移；不活跃返回 active=false。
// day 是该时段所属的配置时区日（跨午夜时回退一天，与 Go 一致）。
export function occurrence(w: QueryWindowRow, at: Date, tz: StockTimezone): Occurrence {
  const p = zonedParts(at, tz);
  const minute = p.hour * 60 + p.minute;
  const offset = ((minute - w.start + 1440) % 1440);
  if (offset >= windowDuration(w)) return { day: "", offset: 0, active: false };
  const dayMinutes = minute < w.start ? minute + 1440 : minute;
  // 回退到该时段起点所属的日历日：跨午夜且 minute < start 时，起点在前一天。
  const dayOffsetDays = minute < w.start ? -1 : 0;
  const key = dayKeyWithOffset(p, dayOffsetDays);
  void dayMinutes;
  return { day: key, offset, active: true };
}

function dayKeyWithOffset(
  p: { year: number; month: number; day: number },
  days: number,
): string {
  const base = Date.UTC(p.year, p.month - 1, p.day + days, 12);
  const d = new Date(base);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export { windowDuration, windowsOverlap, parseClock };

// activeWindow：返回当前处于时段内的（启用与否不论）时段与其所属日。
export function activeWindow(db: Database, at: Date, tz: StockTimezone): { window: QueryWindowRow; day: string } | null {
  for (const w of queryWindows(db)) {
    const occ = occurrence(w, at, tz);
    if (occ.active) return { window: w, day: occ.day };
  }
  return null;
}

// windowUsage：某时段某股票各档位已占用的提醒次数（uid → count）。
// 状态集合与 Go 完全一致：发送中/成功/部分成功/不确定。
export function windowUsage(db: Database, w: QueryWindowRow, day: string, symbol: string): Map<string, number> {
  const rows = db.prepare(`SELECT json_extract(j.value,'$.uid') AS uid,count(*) AS c FROM notifications n, json_each(n.levels) j
    WHERE n.window_id=? AND n.window_day=? AND n.symbol=? AND n.status IN ('发送中','成功','部分成功','不确定')
    GROUP BY json_extract(j.value,'$.uid')`).all(w.id, day, symbol) as Array<{ uid: string | null; c: number }>;
  const usage = new Map<string, number>();
  for (const r of rows) {
    if (r.uid != null) usage.set(r.uid, Number(r.c));
  }
  return usage;
}

export function windowUsageAll(db: Database, w: QueryWindowRow, day: string): Map<string, Map<string, number>> {
  const rows = db.prepare(`SELECT n.symbol AS symbol,json_extract(j.value,'$.uid') AS uid,count(*) AS c FROM notifications n, json_each(n.levels) j
    WHERE n.window_id=? AND n.window_day=? AND n.status IN ('发送中','成功','部分成功','不确定')
    GROUP BY n.symbol,json_extract(j.value,'$.uid')`).all(w.id, day) as Array<{ symbol: string; uid: string | null; c: number }>;
  const usage = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.uid == null) continue;
    let per = usage.get(r.symbol);
    if (!per) {
      per = new Map();
      usage.set(r.symbol, per);
    }
    per.set(r.uid, Number(r.c));
  }
  return usage;
}

// levelUsage：档位列表叠加当前时段用量与上限。
export function levelUsage(db: Database, stockID: number, symbol: string, at: Date, tz: StockTimezone): { levels: Level[]; window: QueryWindowRow | null } {
  const levels = listLevels(db, stockID);
  const active = activeWindow(db, at, tz);
  if (!active) return { levels, window: null };
  const usage = windowUsage(db, active.window, active.day, symbol);
  for (const l of levels) {
    l.Used = usage.get(l.UID) ?? 0;
    l.Limit = alertLimit(l, active.window);
    l.WindowActive = true;
  }
  return { levels, window: active.window };
}

// windowStatus：返回状态文案与「本时段自动查询已停止」标记。
export function windowStatus(db: Database, stockID: number, symbol: string, at: Date, tz: StockTimezone): { status: string; capped: boolean } {
  const { levels, window } = levelUsage(db, stockID, symbol, at, tz);
  return windowSummary(levels, window);
}

export function windowSummary(levels: Level[], w: QueryWindowRow | null): { status: string; capped: boolean } {
  if (!w) return { status: "", capped: false };
  let active = 0;
  let exhausted = 0;
  for (const l of levels) {
    if (l.Enabled) {
      active++;
      if (l.Used >= l.Limit) exhausted++;
    }
  }
  const status = `本时段档位额度：${exhausted}/${active} 个已用尽`;
  if (active > 0 && exhausted === active) {
    return { status: status + " · 本时段自动查询已停止", capped: true };
  }
  if (!w.enabled) {
    return { status: status + " · 时段查询已暂停", capped: false };
  }
  return { status, capped: false };
}

// nextWindowFire：逐真实分钟走查，处理 DST 跳过/重复墙钟（Go 语义）。
export function nextWindowFire(w: QueryWindowRow, tz: StockTimezone, after: Date, makeZoned: (t: Date) => Occurrence): Date | null {
  const end = after.getTime() + 49 * 3600 * 1000;
  // Truncate to minute, then add one minute.
  let t = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  for (; t < end; t += 60000) {
    const occ = makeZoned(new Date(t));
    if (occ.active && occ.offset % w.interval === 0) return new Date(t);
  }
  return null;
}

// timezone 校验（scheduler.go zonePost 规则）。
export function validTimezone(name: string): boolean {
  return name === "Asia/Shanghai" || name === "America/New_York";
}

export function timezoneValue(db: Database): StockTimezone {
  const name = value(db, `SELECT timezone FROM settings WHERE id=1`);
  return (name === "America/New_York" ? "America/New_York" : "Asia/Shanghai") as StockTimezone;
}
