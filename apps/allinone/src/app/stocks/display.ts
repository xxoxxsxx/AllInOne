// 页面共用展示辅助：flash 白名单（notice.go）、状态中文名（web.go Status）、
// 价格展示格式（price_format.go）。纯函数，供各页直接 import。

import { formatPrice } from "@/modules/stocks/price-format";

export function flashText(code: string): string {
  const map: Record<string, string> = {
    stock_added: "股票已添加，可在下方设置提醒价格。",
    stock_saved: "股票设置已保存。",
    stock_deleted: "股票已删除，相关提醒价格一并移除。",
    reference_saved: "收益参考买入价已保存。",
    level_added: "提醒价格已添加。",
    level_paused: "提醒已暂停。",
    level_enabled: "提醒已恢复。",
    level_rearmed: "提醒已重新启用。",
    level_deleted: "提醒已删除。",
    schedule_added: "查询时间点已添加。",
    schedule_saved: "查询时间点已更新。",
    schedule_enabled: "查询时间点已启用。",
    schedule_disabled: "查询时间点已暂停。",
    schedule_deleted: "查询时间点已删除。",
    zone_saved: "显示时区已保存。",
    window_saved: "查询时段已保存。",
    window_deleted: "查询时段已删除。",
    window_enabled: "查询时段已启用。",
    window_disabled: "查询时段已暂停。",
    default_saved: "每档默认提醒上限已更新。",
  };
  return map[code] ?? "";
}

export function statusText(s: string): string {
  switch (s) {
    case "running": return "查询中";
    case "completed": return "已完成";
    case "partial": return "部分完成";
    case "failed":
    case "error": return "失败";
    case "skipped": return "已跳过";
    case "interrupted": return "已中断";
    case "pending": return "等待中";
    case "ok": return "成功";
    default: return s;
  }
}

export function money(raw: string): string {
  return formatPrice(raw);
}
