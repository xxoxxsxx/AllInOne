// NYSE 交易日历（假日 + 提前收市），2026–2028 已核验窗口。
//
// 数据来源：从模块缓存中锁定版本的 go-marketcal
// (github.com/nocturnerxyz/go-marketcal@v0.0.0-20260802160815-d72677789409)
// 的规则实现（internal/rules，基于规则的假日推导 + internal/data/exceptions.json
// 临时休市表）逐项移植，并用该库实际运行输出（2026–2028 年 HOLIDAY/EARLY 列表）
// 逐条核对。exceptions.json 在 2026–2028 窗口内没有临时休市或额外提前收市条目。
// 若未来出现全国哀悼日等临时休市，需人工在此补录并同步扩大窗口说明。

// NYSE 常规时段（墙钟，分钟）：09:30–16:00；提前收市 13:00。
export const REGULAR_OPEN_MIN = 9 * 60 + 30;
export const REGULAR_CLOSE_MIN = 16 * 60;
export const EARLY_CLOSE_MIN = 13 * 60;

export type CalendarTable = {
  // 假日（该日不交易）。周末不列入（按规则排除）。
  holidays: Record<string, string>;
  // 提前收市（该日 13:00 收市）。假日当天不会出现提前收市。
  earlyCloses: Record<string, string>;
};

const TABLE: Record<number, CalendarTable> = {
  2026: {
    holidays: {
      "2026-01-01": "New Year's Day",
      "2026-01-19": "Martin Luther King Jr. Day",
      "2026-02-16": "Washington's Birthday",
      "2026-04-03": "Good Friday",
      "2026-05-25": "Memorial Day",
      "2026-06-19": "Juneteenth National Independence Day",
      "2026-07-03": "Independence Day",
      "2026-09-07": "Labor Day",
      "2026-11-26": "Thanksgiving Day",
      "2026-12-25": "Christmas Day",
    },
    earlyCloses: {
      "2026-11-27": "Day after Thanksgiving",
      "2026-12-24": "Christmas Eve",
    },
  },
  2027: {
    holidays: {
      "2027-01-01": "New Year's Day",
      "2027-01-18": "Martin Luther King Jr. Day",
      "2027-02-15": "Washington's Birthday",
      "2027-03-26": "Good Friday",
      "2027-05-31": "Memorial Day",
      "2027-06-18": "Juneteenth National Independence Day",
      "2027-07-05": "Independence Day",
      "2027-09-06": "Labor Day",
      "2027-11-25": "Thanksgiving Day",
      "2027-12-24": "Christmas Day",
    },
    earlyCloses: {
      "2027-11-26": "Day after Thanksgiving",
    },
  },
  2028: {
    holidays: {
      "2028-01-17": "Martin Luther King Jr. Day",
      "2028-02-21": "Washington's Birthday",
      "2028-04-14": "Good Friday",
      "2028-05-29": "Memorial Day",
      "2028-06-19": "Juneteenth National Independence Day",
      "2028-07-04": "Independence Day",
      "2028-09-04": "Labor Day",
      "2028-11-23": "Thanksgiving Day",
      "2028-12-25": "Christmas Day",
    },
    earlyCloses: {
      "2028-07-03": "Independence Day eve",
      "2028-11-24": "Day after Thanksgiving",
    },
  },
};

// go-marketcal 临时休市核验窗口（Horizon）。
const HORIZON_FROM = "2015-01-01";
const HORIZON_TO = "2030-12-31";

export type CalendarDay = {
  key: string; // "YYYY-MM-DD"
  year: number;
  tradingDay: boolean;
  earlyClose: boolean;
  holidayName: string | null;
};

function dayKeyOf(at: Date, tz: "America/New_York"): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(at);
}

function weekdayOfKey(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

function tableFor(key: string): CalendarTable | null {
  const year = Number(key.slice(0, 4));
  return TABLE[year] ?? null;
}

// 该日是否交易（非周末、非假日）。
export function isTradingDayKey(key: string): boolean {
  const wd = weekdayOfKey(key);
  if (wd === 0 || wd === 6) return false;
  const table = tableFor(key);
  if (!table) return false;
  return !(key in table.holidays);
}

export function holidayName(key: string): string | null {
  const table = tableFor(key);
  if (!table) return null;
  return table.holidays[key] ?? null;
}

export function isEarlyCloseKey(key: string): boolean {
  const table = tableFor(key);
  if (!table) return false;
  return key in table.earlyCloses;
}

// 日历超出核验窗口判断：calendarReviewed 等价 Go 版
// （年份在 2026..2028 且在 go-marketcal Horizon 内）。
export function calendarReviewed(at: Date): boolean {
  const key = dayKeyOf(at, "America/New_York");
  const year = Number(key.slice(0, 4));
  if (year < 2026 || year > 2028) return false;
  // go-marketcal InHorizon：[validFrom, validTo+1天)。
  return key >= HORIZON_FROM && key <= HORIZON_TO;
}

export function tradingDay(key: string): CalendarDay {
  return {
    key,
    year: Number(key.slice(0, 4)),
    tradingDay: isTradingDayKey(key),
    earlyClose: isEarlyCloseKey(key),
    holidayName: holidayName(key),
  };
}

// 常规时段 [开市, 收市)，提前收市日用 13:00。返回 UTC 时刻。
export function regularHours(key: string): { open: Date; close: Date } | null {
  if (!isTradingDayKey(key)) return null;
  const closeMin = isEarlyCloseKey(key) ? EARLY_CLOSE_MIN : REGULAR_CLOSE_MIN;
  const open = zonedNY(key, REGULAR_OPEN_MIN);
  const close = zonedNY(key, closeMin);
  if (!open || !close) return null;
  return { open, close };
}

// 该时刻是否处于 NYSE 常规时段。
export function isOpen(at: Date): boolean {
  const key = dayKeyOf(at, "America/New_York");
  const hours = regularHours(key);
  if (!hours) return false;
  return at.getTime() >= hours.open.getTime() && at.getTime() < hours.close.getTime();
}

// 把 "YYYY-MM-DD" + 墙钟分钟换算为 America/New_York 的 UTC 时刻。
// （本模块不依赖 tz.ts，避免与配置时区语义耦合；DST 由 Intl 处理，
// 该函数仅用于 09:30/13:00/16:00 这三个存在的墙钟，不会跨不存在时刻。）
function zonedNY(key: string, minute: number): Date | null {
  const guess = Date.parse(`${key}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`);
  if (Number.isNaN(guess)) return null;
  const offset = nyOffset(new Date(guess), key, minute);
  return new Date(guess - offset);
}

function nyOffset(at: Date, key: string, minute: number): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = f.formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUTC - Date.parse(`${key}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`);
}

// 供展示/测试：列出某年假日与提前收市。
export function calendarForYear(year: number): CalendarTable | null {
  return TABLE[year] ?? null;
}
