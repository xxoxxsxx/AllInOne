// 证件到期提醒渠道配置 —— 兼容委托层。
// 渠道配置的实际存储已迁移到全局推送渠道中心（src/lib/channels/center.ts，
// DATA_DIR/channels/channels.db 的 channels 表），证件夹/提醒模块不再在 documents.db
// 里维护 reminder_channels 表。本文件保留原有公开函数签名（db 参数保留但忽略），
// 全部转发给中心，已有调用方（设置页 / Server Actions / runner / 测试）无需改动；
// 旧 documents.db 的 reminder_channels 行由中心的一次性 copy-if-empty 迁移接管（只读）。
// 语义与迁移前一致：
// - 保存采用「合并语义」：文本字段缺省或留空 = 保持现有值；开关布尔字段按提交值应用；
//   非空值经 stocks notify 的 check* 校验（中文报错），失败不落库。
// - 「从行情设置导入」是一次性显式操作（importChannelsFromStocks）：动态加载 stocks store
//   读取 notificationSettings 并整行覆盖中心配置（含空值清空），失败返回 ok:false。

import type Database from "better-sqlite3";

import {
  clearGlobalChannel,
  getChannelConfig,
  getChannelsDb,
  loadChannelConfig,
  saveChannelConfig,
  summarizeChannelConfig,
  writeChannelConfig,
  type ReminderChannelsInput,
  type ReminderChannelsSummary,
} from "@/lib/channels/center";
import type { ChannelConfig } from "@/modules/stocks/notify";

export {
  clearGlobalChannel,
  getChannelConfig,
  getChannelsDb,
  loadChannelConfig,
  saveChannelConfig,
  summarizeChannelConfig,
  summarizeChannels,
  writeChannelConfig,
} from "@/lib/channels/center";
export type { ReminderChannelsInput, ReminderChannelsSummary } from "@/lib/channels/center";

/** 兼容入口：中心库在建连接时已惰性建表（db 参数保留但忽略）。 */
export function ensureReminderChannelsSchema(_db: Database.Database): void {
  getChannelsDb();
}

/** 读取渠道配置（来自全局中心；db 参数保留但忽略）。 */
export function getReminderChannels(_db: Database.Database): ChannelConfig {
  return getChannelConfig();
}

/** 合并保存渠道配置（写入全局中心；db 参数保留但忽略）。 */
export function saveReminderChannels(_db: Database.Database, input: ReminderChannelsInput): ChannelConfig {
  return saveChannelConfig(input ?? {});
}

/** 明确清除一个渠道或代理的所有配置（作用于全局中心；db 参数保留但忽略）。 */
export function clearReminderChannel(_db: Database.Database, name: "Bark" | "飞书" | "Telegram" | "代理"): ChannelConfig {
  return clearGlobalChannel(name);
}

/** 渠道状态摘要（服务端用；不返回任何机密，Bark 仅主机名）。 */
export function summarizeReminderChannels(_db: Database.Database): ReminderChannelsSummary {
  return summarizeChannelConfig();
}

/** 推送路径的默认配置来源：只读中心库；读取失败返回 null（永不抛错）。 */
export function loadReminderChannelConfig(_db: Database.Database): ChannelConfig | null {
  return loadChannelConfig();
}

export type StocksImportResult =
  | { ok: true; config: ChannelConfig }
  | { ok: false; error: string };

/**
 * 一次性显式导入：动态加载 stocks store 读取 notificationSettings，整行覆盖「全局中心」
 * 的渠道配置（含空值清空，真正的「覆盖」）。stocks 库缺失/损坏 → { ok:false }，
 * 不抛错、不改动现有配置。这是证件夹提醒代码里唯一接触 stocks 库的地方，
 * 且仅在用户显式点击导入时执行。
 */
export async function importChannelsFromStocks(_db: Database.Database): Promise<StocksImportResult> {
  try {
    const { getDB, notificationSettings } = await import("@/modules/stocks/store");
    const stocksConfig = notificationSettings(getDB());
    if (!stocksConfig.Bark.URL && !stocksConfig.Bark.Key && !stocksConfig.FeishuWebhook && !stocksConfig.FeishuSecret && !stocksConfig.TGToken && !stocksConfig.TGChatID && !stocksConfig.Proxy) {
      return { ok: false, error: "行情设置没有可导入的通知配置，当前配置未更改" };
    }
    writeChannelConfig(stocksConfig);
    return { ok: true, config: getChannelConfig() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "无法读取行情通知配置" };
  }
}
