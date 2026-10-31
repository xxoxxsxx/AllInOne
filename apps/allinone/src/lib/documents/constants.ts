// 证件夹共享常量与纯函数：客户端组件也会引用，此文件必须保持无 Node 依赖。

// 到期提醒阈值：30 天内标记「即将到期」。
export const EXPIRY_WARN_DAYS = 30;
// 每份证件最多附件数。
export const MAX_FILES_PER_DOCUMENT = 12;

export type DocStatus = "valid" | "upcoming" | "expiring" | "expired";

export const STATUS_LABELS: Record<DocStatus, string> = {
  valid: "有效",
  upcoming: "尚未生效",
  expiring: "即将到期",
  expired: "已过期",
};

/** 证件号打码：保留末 2 位，其余以 • 代替；过短则全部打码。 */
export function maskNumber(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (v.length <= 3) return "•".repeat(v.length);
  return "•".repeat(Math.max(v.length - 2, 2)) + v.slice(-2);
}

/** 证件日期统一按北京时间，避免容器与浏览器时区不同导致提醒跨日。 */
export function todayStr(nowMs: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** 开始日期 + 时长 → 到期日（UTC 日期运算；月末截断，如 1-31 + 1 月 = 2-28/29）。 */
export function addDuration(startDate: string, value: number, unit: "day" | "month" | "year"): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || startDate.startsWith("0000-") || !Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== startDate) {
    throw new Error("开始日期格式无效");
  }
  if (!Number.isSafeInteger(value) || Math.abs(value) > 120_000 || !["day", "month", "year"].includes(unit)) throw new Error("有效期时长无效");
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  if (unit === "day") {
    start.setUTCDate(d + value);
    if (start.getUTCFullYear() < 1 || start.getUTCFullYear() > 9999) throw new Error("计算出的到期日超出范围");
    return start.toISOString().slice(0, 10);
  }
  const months = unit === "month" ? value : value * 12;
  const targetYear = y + Math.floor((m + months) / 12);
  const targetMonth = ((m + months) % 12 + 12) % 12;
  if (targetYear < 1 || targetYear > 9999) throw new Error("计算出的到期日超出范围");
  const end = new Date(0);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCFullYear(targetYear, targetMonth + 1, 0);
  const day = Math.min(d, end.getUTCDate());
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 到期日当天仍有效；开始日在未来时提示尚未生效。 */
export function statusOf(
  expiryDate: string,
  today: string = todayStr(),
  startDate = "",
): { status: DocStatus; daysLeft: number | null } {
  let daysLeft: number | null = null;
  if (expiryDate) {
    daysLeft = Math.round((Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (daysLeft < 0) return { status: "expired", daysLeft };
  }
  if (daysLeft !== null && daysLeft <= EXPIRY_WARN_DAYS) return { status: "expiring", daysLeft };
  if (startDate && startDate > today) return { status: "upcoming", daysLeft };
  return { status: "valid", daysLeft };
}
