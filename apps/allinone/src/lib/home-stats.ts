import type Database from "better-sqlite3";

import { getDashboardStats } from "@/lib/ledger/events";
import type { ScheduleLike } from "@/lib/reminders/schedules";
import { getRemindersDB, listRunSchedules } from "@/lib/reminders/store";
import { getDB } from "@/modules/stocks/store";

// 工具箱首页聚合：每个模块只做一次轻量读取；任一模块失败时返回 null，
// 首页隐藏对应数字而不影响其余模块。

export type HomeModuleStats = {
  cdkActive: number | null;
  remindersToday: number | null;
  stockAlertsToday: number | null;
};

// 北京时间的「今天」起止（毫秒）。
export function shanghaiDayRange(nowMs: number): { startMs: number; endMs: number } {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  const startMs = Date.parse(`${day}T00:00:00+08:00`);
  return { startMs, endMs: startMs + 86400000 };
}

// 首页「今日待办提醒」：启用中的调度里，今天（北京时间）结束前仍有待触发次数的提醒数量。
// 判定与 reminders/schedules.computeDue 的口径一致：
// - once：未发送且未被标记错过（已到点但还在宽限期内待补发的也算待办）；
// - interval：尚有剩余槽位且下一个待处理槽位在今天结束前；
// - cron：下一次触发时间在今天结束前（next_at 由调度器 tick 维护，为空则无法判定）。
export function remindersTodayPendingCount(
  schedules: ScheduleLike[],
  nowMs: number,
): number {
  const { endMs } = shanghaiDayRange(nowMs);
  let count = 0;

  for (const s of schedules) {
    if (!s.enabled || s.missedAt !== null) continue;

    if (s.kind === "once") {
      if (s.sent < 1 && s.at !== null && s.at <= endMs) count += 1;
      continue;
    }

    if (s.kind === "interval") {
      const stepMs = (s.intervalSeconds ?? 0) * 1000;
      const pointer =
        s.nextAt ??
        (s.startAt !== null && stepMs >= 1000 ? s.startAt + s.sent * stepMs : null);
      const remaining = (s.total ?? 0) - s.sent;
      if (s.startAt !== null && remaining >= 1 && pointer !== null && pointer <= endMs) {
        count += 1;
      }
      continue;
    }

    if (s.nextAt !== null && s.nextAt <= endMs) count += 1;
  }

  return count;
}

export function getRemindersTodayPending(): number | null {
  try {
    const schedules = listRunSchedules(getRemindersDB()).map((r) => r.schedule);
    return remindersTodayPendingCount(schedules, Date.now());
  } catch {
    return null;
  }
}

// 首页「今日股票触发」：今天（北京时间）写入的报警通知条数。
// notifications.created_at 与 stocks store.now() 同为 UTC ISO 字符串（Z 结尾），
// 但可能带毫秒小数，截取前 19 位（秒级）比较，避免 "…00.5Z" 与 "…00Z" 的字典序陷阱。
export function stocksAlertsTodayCount(db: Database.Database, nowMs: number): number {
  const { startMs, endMs } = shanghaiDayRange(nowMs);
  const startSecond = new Date(startMs).toISOString().slice(0, 19);
  const endSecond = new Date(endMs).toISOString().slice(0, 19);
  const row = db
    .prepare(
      "select count(*) as c from notifications where substr(created_at, 1, 19) >= ? and substr(created_at, 1, 19) < ?",
    )
    .get(startSecond, endSecond) as { c: number };
  return row.c;
}

export function getStocksAlertsToday(): number | null {
  try {
    return stocksAlertsTodayCount(getDB(), Date.now());
  } catch {
    return null;
  }
}

// 页面入口：按工具箱启用的模块聚合，禁用的模块返回 null。
export async function collectHomeModuleStats(enabled: {
  cdkLedger: boolean;
  reminders: boolean;
  stocks: boolean;
}): Promise<HomeModuleStats> {
  const [remindersToday, cdkActive, stockAlertsToday] = await Promise.all([
    Promise.resolve().then(() => (enabled.reminders ? getRemindersTodayPending() : null)),
    (async () => {
      if (!enabled.cdkLedger) return null;
      try {
        // 全表扫描状态推导，个人台账量级下毫秒级；首页为 force-dynamic 页面。
        return (await getDashboardStats()).activeTotal;
      } catch (error) {
        console.error("首页有效 CDK 统计读取失败", error);
        return null;
      }
    })(),
    Promise.resolve().then(() => (enabled.stocks ? getStocksAlertsToday() : null)),
  ]);

  return { cdkActive, remindersToday, stockAlertsToday };
}
