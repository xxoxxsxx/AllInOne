// 提醒事项共享常量：客户端组件也会引用，此文件必须保持无 Node 依赖（与 documents/constants 同规则）。

export const REMINDERS_MAX_TEXT_LENGTH = 2000;
export const REMINDERS_MAX_IMAGES = 12;
export const REMINDERS_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 间隔重复允许的最小/最大间隔秒数与最大次数。 */
export const REMINDERS_MIN_INTERVAL_SECONDS = 60;
export const REMINDERS_MAX_INTERVAL_SECONDS = 10 * 366 * 86400;
export const REMINDERS_MAX_INTERVAL_TOTAL = 99999;

export type IntervalUnit = "minute" | "hour" | "day" | "week";

export const INTERVAL_UNIT_SECONDS: Record<IntervalUnit, number> = {
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
};

export const INTERVAL_UNIT_LABELS: Record<IntervalUnit, string> = {
  minute: "分钟",
  hour: "小时",
  day: "天",
  week: "周",
};

/** 把间隔秒数折算成 (数量, 单位)：优先大单位，能整除才采用；都不行时返回分钟（可能非整数）。 */
export function intervalToValueUnit(seconds: number): { value: number; unit: IntervalUnit } {
  const units: IntervalUnit[] = ["week", "day", "hour", "minute"];
  for (const unit of units) {
    const factor = INTERVAL_UNIT_SECONDS[unit];
    if (seconds >= factor && seconds % factor === 0) return { value: seconds / factor, unit };
  }
  return { value: Math.round((seconds / INTERVAL_UNIT_SECONDS.minute) * 100) / 100, unit: "minute" };
}
