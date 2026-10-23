// 下次执行时间计算（scheduler.go nextFire + windows.go nextWindowFire）。

import { zonedTime, zonedParts, type StockTimezone } from "./tz";
import type { QueryWindowRow } from "./store";
import { occurrence } from "./windows";

// nextFire：固定时间点的下次执行（Go nextFire 语义：从明天起最多找 370 天，
// DST 不存在的墙钟分钟被跳过；今天若已过该时刻则不算）。
export function nextFireForSchedule(hour: number, minute: number, tz: StockTimezone, after: Date): Date | null {
  const p = zonedParts(after, tz);
  for (let i = 0; i < 370; i++) {
    // 目标日 = 本地日 + i；用 UTC 毫秒加天数近似换日，再取该日墙钟。
    const dayUTC = Date.UTC(p.year, p.month - 1, p.day + i, 12);
    const day = new Date(dayUTC);
    const dp = zonedParts(day, tz);
    const t = zonedTime(tz, dp.year, dp.month, dp.day, hour, minute);
    if (t && t.getTime() > after.getTime()) return t;
  }
  return null;
}

// nextWindowFire：逐分钟走查（49 小时窗口），起点对齐间隔。
export function nextWindowOccurrence(w: QueryWindowRow, tz: StockTimezone, after: Date): Date | null {
  const end = after.getTime() + 49 * 3600 * 1000;
  let t = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  for (; t < end; t += 60000) {
    const occ = occurrence(w, new Date(t), tz);
    if (occ.active && occ.offset % w.interval === 0) return new Date(t);
  }
  return null;
}
