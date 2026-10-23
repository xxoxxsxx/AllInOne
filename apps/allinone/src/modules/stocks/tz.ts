// 配置时区（Asia/Shanghai / America/New_York）下的时间计算。
// 无第三方依赖：用 Intl.DateTimeFormat 做时区偏移换算（支持 DST）。

export type StockTimezone = "Asia/Shanghai" | "America/New_York";

const TZ_PATTERN = /^(Asia\/Shanghai|America\/New_York)$/;

export function isStockTimezone(name: string): name is StockTimezone {
  return TZ_PATTERN.test(name);
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

// 该时刻在目标时区的墙钟时间（字段均按本地数值）。
export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function zonedParts(at: Date, tz: StockTimezone): ZonedParts {
  const parts = formatter(tz).formatToParts(at);
  const get = (type: string): number => {
    const v = parts.find((p) => p.type === type);
    return v ? Number(v.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // en-US 可能输出 "24:xx" 表示午夜
    minute: get("minute"),
    second: get("second"),
  };
}

function partsToUTCKey(p: ZonedParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function offsetMs(at: Date, tz: StockTimezone): number {
  const p = zonedParts(at, tz);
  const asUTC = partsToUTCKey(p);
  return asUTC - Math.floor(at.getTime() / 1000) * 1000 - at.getMilliseconds();
}

// 给定时区的墙钟时间构造 UTC 时刻。该墙钟不存在（春令时跳过）时返回 null；
// 该墙钟出现两次（秋令时回拨）时取较早的一次（offset 按之前的规则取较大者前次为较小偏移，
// Go time.Date 语义是「歧义时刻取先出现的那个」，即较小的 UTC 时刻）。
export function zonedTime(
  tz: StockTimezone,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const before = new Date(guess - 24 * 3600 * 1000);
  const off1 = offsetMs(before, tz);
  const candidate = new Date(guess - off1);
  const off2 = offsetMs(candidate, tz);
  if (off2 === off1) {
    // 校验墙钟确实落在该时区当天（处理月/日进位由调用方保证合法）。
    return candidate;
  }
  // 两次偏移不同：可能跨 DST。再以第二个偏移迭代一次收敛。
  const candidate2 = new Date(guess - off2);
  const off3 = offsetMs(candidate2, tz);
  if (off3 === off2) {
    // 歧义时刻：Go 语义取较早者。
    const earlier = candidate2.getTime() < candidate.getTime() ? candidate2 : candidate;
    return earlier;
  }
  // 墙钟不存在（春季前拨跳过）。
  return null;
}

// t 在 tz 的当日起点（午夜）对应的 UTC 时刻。
export function startOfDay(t: Date, tz: StockTimezone): Date {
  const p = zonedParts(t, tz);
  const d = zonedTime(tz, p.year, p.month, p.day, 0, 0);
  return d ?? new Date(Date.UTC(p.year, p.month - 1, p.day));
}

// 该墙钟日期 + N 天在 tz 中的午夜；DST 不存在时退回近似的 UTC 加减。
export function addDays(startOf: Date, days: number, tz: StockTimezone): Date {
  const p = zonedParts(startOf, tz);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + days, 12, 0, 0));
  const np = zonedParts(next, tz);
  const d = zonedTime(tz, np.year, np.month, np.day, 0, 0);
  return d ?? new Date(Date.UTC(np.year, np.month - 1, np.day));
}

export function weekdayOf(t: Date, tz: StockTimezone): number {
  // 0=Sunday .. 6=Saturday，按目标时区的日历日。
  const p = zonedParts(t, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// Go 版 time.RFC3339：形如 2026-01-02T15:04:05Z（秒精度，无毫秒）。
export function rfc3339(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Go 版 time.RFC3339Nano：尾随零被省略（0/3/6/9 位小数）。
export function rfc3339Nano(at: Date): string {
  const ms = at.getUTCMilliseconds();
  const base = at.toISOString().slice(0, 19);
  if (ms === 0) return `${base}Z`;
  let frac = String(ms).padStart(3, "0");
  frac = frac.replace(/0+$/, "");
  return `${base}.${frac}Z`;
}

// quotaAt：固定 9 位纳秒格式 "2006-01-02T15:04:05.000000000Z"。
export function quotaAt(t: Date): string {
  return `${t.toISOString().slice(0, 19)}.${String(t.getUTCMilliseconds()).padStart(3, "0")}000000Z`;
}

// 解析 RFC3339 / RFC3339Nano。失败返回 null。
export function parseRFC3339(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac, zone] = m;
  let ms = 0;
  if (frac) ms = Math.round(Number(`0${frac}`) * 1000);
  if (ms > 999) ms = 999;
  let ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se), ms);
  if (zone !== "Z" && zone !== "z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    ts -= sign * (oh * 3600 + om * 60) * 1000;
  }
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 时区内的日期键 "2006-01-02"。
export function dateKey(t: Date, tz: StockTimezone): string {
  const p = zonedParts(t, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

// 时区内 "2006-01-02T15:04"（窗口的 window_day 与 slot 文案）。
export function minuteKey(t: Date, tz: StockTimezone): string {
  const p = zonedParts(t, tz);
  return `${dateKey(t, tz)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

// "15:04" → 分钟数；严格校验（Go time.Parse("15:04") 会拒绝 "9:30"/"9:0x" 之外的宽松写法）。
export function parseClock(text: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function clockText(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

// 页面显示：配置时区 "2006-01-02 15:04:05 MST"。
const zoneNameCache = new Map<string, Intl.DateTimeFormat>();

export function displayClock(at: Date | null, tz: string): string {
  if (!at) return "—";
  if (!isStockTimezone(tz)) {
    // 非法时区退回 UTC（Go 版 LoadLocation 失败时同样退回 UTC）。
    return formatIn(at, "UTC", "UTC");
  }
  return formatIn(at, tz, tz);
}

function formatIn(at: Date, tz: string, label: string): string {
  let f = zoneNameCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    zoneNameCache.set(tz, f);
  }
  const text = f.format(at); // "2026-01-02 15:04:05"
  return `${text} ${label}`;
}
