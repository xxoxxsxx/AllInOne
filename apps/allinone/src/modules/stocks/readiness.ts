// 自检清单（readiness.go quoteReadiness + readiness）。

import { calendarReviewed, isOpen } from "./calendar";
import { alertValidity } from "./quote";
import { targetGap } from "./store";
import type { Stock } from "./store";
import { enabledChannels, type ChannelConfig } from "./notify";
import { parseRFC3339 } from "./tz";

export function quoteReadiness(s: Stock, now: Date): string {
  if (!s.Enabled) return "股票已暂停";
  if (s.LastPrice === "") return "尚无有效报价";
  if (s.LastStatus !== "ok") return "最新查询未成功；下方差距沿用旧报价";
  const at = parseRFC3339(s.LastAt);
  if (!at) return "行情时间无效";
  const why = alertValidity(
    { At: at, TimeField: s.TimeField, AssetOK: s.AssetOK },
    now,
    calendarReviewed,
    isOpen,
    regularHoursFor,
  );
  if (why !== "") return why;
  return "最近报价符合触价条件；实际通知取决于档位状态和各渠道发送结果";
}

function regularHoursFor(t: Date): { open: Date; close: Date } | null {
  // calendar.regularHours 接收 YYYY-MM-DD 键；这里把时刻转成 NYSE 日期键。
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(t);
  const hours = regularHoursOfKey(key);
  return hours;
}

import { regularHours as regularHoursOfKey } from "./calendar";

export function readiness(config: ChannelConfig, keySet: boolean, scheduled: boolean, now: Date): string[] {
  const out: string[] = [];
  out.push("触价通知：自动查询和手动查询均会在有效报价命中时发送到所有已启用渠道");
  if (keySet) {
    out.push("行情 Key：已配置，查询成功后才能判断报价有效性");
  } else {
    out.push("行情 Key：未配置，无法查询");
  }
  const names = enabledChannels(config);
  if (names.length > 0) {
    out.push(`通知渠道：${names.join("、")} 已启用；实际送达请在接收端确认`);
  } else {
    out.push("通知渠道：无启用且配置完整的渠道，命中后无法发送通知");
  }
  if (scheduled) {
    out.push("自动查询时间：已配置");
  } else {
    out.push("自动查询时间：未启用，请先设置查询时间");
  }
  if (!calendarReviewed(now)) {
    out.push("交易日历：超出核验范围，停止触价");
  } else if (!isOpen(now)) {
    out.push("市场：当前休市，查询报价不会触价");
  } else {
    out.push("市场：常规交易时段");
  }
  return out;
}

export { targetGap };
