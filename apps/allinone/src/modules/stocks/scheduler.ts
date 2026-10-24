// 调度器（scheduler.go scheduleLoop + fireSchedules + scheduled 语义）：
// - 统一 tick 循环：每分钟对齐检查；启动时所在的那一分钟不回放。
// - 时间漂移（sleep/离线超过一分钟）不补跑。
// - 固定时间点（schedules）与查询时段（query_windows，起点执行终点不执行、按起点对齐间隔）。
// - 同一本地墙钟分钟去重（runs.slot）；休市/日历外/上一轮运行中/未配置 Key 时记录 skipped。
// - 额度耗尽的股票不进入本轮（windowStatus.capped）。

import type { Database } from "better-sqlite3";

import { calendarReviewed, isOpen } from "./calendar";
import { apiKeyOf, getDB, listStocks, listLevels, now, pruneHistory, queryWindows, schedules, value } from "./store";
import type { Stock } from "./store";
import { activeWindow, occurrence as windowOccurrence, timezoneValue } from "./windows";
import { minuteKey, zonedParts, rfc3339Nano } from "./tz";
import type { StockTimezone } from "./tz";
import { startScheduledRun } from "./run";
import { currentRunningID } from "./run";

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// 导出 startStocksScheduler：不抛错、可重复调用安全（接口契约）。
export function startStocksScheduler(): void {
  if (started) return;
  if (process.env.DISABLE_SCHEDULER === "1") return;
  try {
    getDB();
  } catch {
    // 数据库不可用时静默退出，避免把页面渲染拖垮；下次调用可重试。
    return;
  }
  started = true;
  // Never replay the minute during which the process started.
  let lastMinute = Math.floor(Date.now() / 60000);
  const tick = (): void => {
    try {
      const currentMinute = Math.floor(Date.now() / 60000);
      if (currentMinute <= lastMinute) {
        scheduleNext();
        return;
      }
      const elapsed = currentMinute - lastMinute;
      lastMinute = currentMinute;
      if (elapsed !== 1) {
        // sleep/offline minutes are not caught up
        scheduleNext();
        return;
      }
      fireSchedules(getDB(), new Date(currentMinute * 60000));
    } catch {
      // 调度失败不影响下一轮。
    }
    scheduleNext();
  };
  const scheduleNext = (): void => {
    // 对齐到下一分钟的边界触发。
    const delay = 60000 - (Date.now() % 60000) + 15;
    timer = setTimeout(tick, delay);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  };
  scheduleNext();
  cleanupTimer = setInterval(() => {
    try {
      pruneHistory(getDB(), new Date());
    } catch {
      // 清理失败仅记录。
    }
  }, 24 * 3600 * 1000);
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) cleanupTimer.unref();
}

// 供测试：停止调度循环。
export function stopStocksSchedulerForTest(): void {
  if (timer) clearTimeout(timer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  timer = null;
  cleanupTimer = null;
  started = false;
}

// fireSchedules：对齐分钟后触发（可独立测试）。
export function fireSchedules(db: Database, at: Date): void {
  const tz = timezoneValue(db);
  const local = minuteKey(at, tz);
  const list = schedules(db);
  const windows = queryWindows(db);
  for (const w of windows) {
    const occ = windowOccurrence(w, at, tz);
    if (w.enabled && occ.active && occ.offset % w.interval === 0) {
      scheduled(db, 0, at, local, tz);
    }
  }
  const parts = zonedParts(at, tz);
  for (const s of list) {
    if (s.enabled && s.hour === parts.hour && s.minute === parts.minute) {
      scheduled(db, s.id, at, local, tz);
    }
  }
}

// 同一分钟只触发一次（跨进程重启也由 runs 表的 (schedule_id,slot) 唯一索引兜底）。
const firedSlots = new Set<string>();

export function scheduled(db: Database, scheduleID: number, at: Date, slot: string, tz: StockTimezone): void {
  const seen = Number(value(db, `SELECT count(*) FROM runs WHERE kind='scheduled' AND slot=?`, slot));
  if (seen > 0) return; // DST 回拨的重复墙钟分钟只执行一次
  const dedupeKey = `${scheduleID}:${slot}`;
  if (firedSlots.has(dedupeKey)) return;
  firedSlots.add(dedupeKey);
  let reason = "";
  if (!calendarReviewed(at)) {
    reason = "交易日历超出已核验年份";
  } else if (!isOpen(at)) {
    reason = "市场休市或不在常规交易时段";
  } else if (currentRunningID() !== 0) {
    // Coalesce this tick into the active query rather than enqueueing another run.
    return;
  }
  const key = apiKeyOf(db);
  if (reason === "" && key.trim() === "") {
    reason = "未配置 Twelve Data Key";
  }
  const all = listStocks(db);
  const active: Stock[] = [];
  if (reason === "") {
    for (const s of all) {
      if (!s.Enabled) continue;
      const { capped } = stockWindowStatus(db, s.ID, s.Symbol, at, tz);
      if (capped) continue;
      active.push(s);
    }
    if (active.length === 0) {
      reason = "没有可查询的股票（未启用或本时段所有档位额度已用尽）";
    }
  }
  const due = slot;
  const slotAt = rfc3339Nano(at);
  if (reason !== "") {
    db.prepare(`INSERT OR IGNORE INTO runs(kind,started_at,finished_at,status,reason,schedule_id,slot,slot_at) VALUES('scheduled',?,?, 'skipped',?,?,?,?)`)
      .run(now(), now(), reason, scheduleID, due, slotAt);
    return;
  }
  startScheduledRun(db, active, scheduleID, due, slotAt, tz);
}

function stockWindowStatus(db: Database, stockID: number, symbol: string, at: Date, tz: StockTimezone): { status: string; capped: boolean } {
  const levels = listLevels(db, stockID);
  const active = activeWindow(db, at, tz);
  if (!active) return { status: "", capped: false };
  const rows = db.prepare(`SELECT json_extract(j.value,'$.uid') AS uid,count(*) AS c FROM notifications n, json_each(n.levels) j
    WHERE n.window_id=? AND n.window_day=? AND n.symbol=? AND n.status IN ('发送中','成功','部分成功','不确定')
    GROUP BY json_extract(j.value,'$.uid')`).all(active.window.id, active.day, symbol) as Array<{ uid: string | null; c: number }>;
  const usage = new Map<string, number>();
  for (const r of rows) if (r.uid != null) usage.set(r.uid, Number(r.c));
  let activeCount = 0;
  let exhausted = 0;
  for (const l of levels) {
    if (!l.Enabled) continue;
    activeCount++;
    const used = usage.get(l.UID) ?? 0;
    const limit = l.MaxAlerts > 0 ? l.MaxAlerts : active.window.max_alerts;
    if (used >= limit) exhausted++;
  }
  const status = `本时段档位额度：${exhausted}/${activeCount} 个已用尽`;
  if (activeCount > 0 && exhausted === activeCount) return { status: status + " · 本时段自动查询已停止", capped: true };
  if (!active.window.enabled) return { status: status + " · 时段查询已暂停", capped: false };
  return { status, capped: false };
}

// 供测试：清空进程内分钟去重集合。
export function resetFiredSlots(): void {
  firedSlots.clear();
}
