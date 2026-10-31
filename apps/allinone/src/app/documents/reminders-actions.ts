"use server";

// 证件到期提醒 Server Actions：供提醒设置面板（settings/reminders-settings.tsx）调用。
// 与 documents/actions.ts 分离，避免改动既有证件动作；全部返回 { ok, ... }，不向客户端抛异常。
// 渠道配置保存在证件夹自己的 reminder_channels 表（documents.db），独立于行情设置；
// 与 stocks 的唯一交集是「从行情设置导入」这一次性显式动作（内部动态加载，见 reminders-channels）。
// 设置页需要明文显示渠道配置；保存/清除/导入成功时返回最新配置以同步表单。

import { revalidatePath } from "next/cache";

import { getDocumentsDB } from "@/lib/documents/db";
import {
  getReminderSettings,
  REMINDER_TITLE,
  saveReminderSettings,
  type ReminderSettings,
} from "@/lib/documents/reminders";
import { enabledChannels, sendChannel, type ChannelConfig } from "@/modules/stocks/notify";
import {
  clearReminderChannel,
  importChannelsFromStocks,
  loadReminderChannelConfig,
  saveReminderChannels,
  summarizeChannels,
  summarizeReminderChannels,
  type ReminderChannelsInput,
  type ReminderChannelsSummary,
} from "@/lib/documents/reminders-channels";
import {
  defaultChannelSender,
  dispatchToEnabledChannels,
  runDocumentExpiryCheck,
  type ReminderRunResult,
} from "@/lib/documents/reminders-run";

export type ReminderActionResult =
  | { ok: true; settings: ReminderSettings; channels: ReminderChannelsSummary }
  | { ok: false; error: string; channels: ReminderChannelsSummary };

export type ChannelsSaveResult =
  | { ok: true; channels: ReminderChannelsSummary; config: ChannelConfig }
  | { ok: false; error: string; channels: ReminderChannelsSummary };

export type ReminderTestResult =
  | { ok: true; status: string; channels: import("@/lib/documents/reminders-run").ChannelSendResult[] }
  | { ok: false; error: string; channels: import("@/lib/documents/reminders-run").ChannelSendResult[] };

export type ChannelTestResult =
  | { ok: true; name: string; status: string }
  | { ok: false; name: string; error: string };

export type ReminderRunActionResult =
  | { ok: true; result: ReminderRunResult }
  | { ok: false; error: string };

export type ChannelsImportResult =
  | { ok: true; channels: ReminderChannelsSummary; config: ChannelConfig }
  | { ok: false; error: string };

const NO_CHANNELS_ERROR =
  "尚未配置任何推送渠道：请在下方启用并配置 Bark / 飞书 / Telegram 至少一个渠道";

function failChannels(error: unknown): { ok: false; error: string; channels: ReminderChannelsSummary } {
  let channels: ReminderChannelsSummary;
  try {
    channels = summarizeReminderChannels(getDocumentsDB());
  } catch {
    channels = summarizeChannels({
      Bark: { URL: "", Key: "", Local: false }, BarkEnabled: false,
      FeishuWebhook: "", FeishuSecret: "", FeishuEnabled: false,
      TGToken: "", TGChatID: "", TGEnabled: false,
      Proxy: "", BarkProxy: false, FeishuProxy: false, TGProxy: false,
    });
  }
  return { ok: false, error: error instanceof Error ? error.message : "操作失败", channels };
}

/** 当前提醒设置（含 last_sent_date）与渠道摘要（绝不含机密），供面板状态展示。 */
export async function getReminderSettingsAction(): Promise<ReminderActionResult> {
  try {
    const db = getDocumentsDB();
    return { ok: true, settings: getReminderSettings(db), channels: summarizeReminderChannels(db) };
  } catch (e) {
    return failChannels(e);
  }
}

/** 保存提醒开关与时刻（Asia/Shanghai 小时 0–23）。 */
export async function saveReminderSettingsAction(enabled: boolean, hour: number): Promise<ReminderActionResult> {
  try {
    const db = getDocumentsDB();
    const settings = saveReminderSettings(db, { enabled: enabled === true, hour });
    revalidatePath("/documents");
    revalidatePath("/documents/settings");
    return { ok: true, settings, channels: summarizeReminderChannels(db) };
  } catch (e) {
    return failChannels(e);
  }
}

/**
 * 保存推送渠道配置（合并语义）：文本字段留空/缺省 = 保持现有值，
 * 开关按提交值应用；非空值经 stocks notify 校验，失败时原配置不变。
 */
export async function saveReminderChannelsAction(input: ReminderChannelsInput): Promise<ChannelsSaveResult> {
  try {
    const db = getDocumentsDB();
    const config = saveReminderChannels(db, input ?? {});
    revalidatePath("/documents/settings");
    return { ok: true, channels: summarizeChannels(config), config };
  } catch (e) {
    return failChannels(e);
  }
}

/** 清除指定渠道或代理的全部配置。 */
export async function clearReminderChannelAction(name: string): Promise<ChannelsSaveResult> {
  try {
    if (name !== "Bark" && name !== "飞书" && name !== "Telegram" && name !== "代理") throw new Error("渠道无效");
    const config = clearReminderChannel(getDocumentsDB(), name);
    revalidatePath("/documents/settings");
    return { ok: true, channels: summarizeChannels(config), config };
  } catch (e) {
    return failChannels(e);
  }
}

/** 发送一条测试推送（所有已启用渠道）；不影响 last_sent_date，也不依赖提醒开关。 */
export async function testReminderAction(): Promise<ReminderTestResult> {
  try {
    const config = loadReminderChannelConfig(getDocumentsDB());
    if (!config || enabledChannels(config).length === 0) {
      return { ok: false, error: NO_CHANNELS_ERROR, channels: [] };
    }
    const { aggregate, channels } = await dispatchToEnabledChannels(
      config,
      REMINDER_TITLE,
      "这是一条测试通知：证件到期提醒渠道工作正常。",
      defaultChannelSender,
    );
    if (aggregate === "失败") {
      return { ok: false, error: "所有启用渠道均发送失败，请检查渠道配置", channels };
    }
    return { ok: true, status: aggregate, channels };
  } catch (e) {
    const error = e instanceof Error ? e.message : "操作失败";
    return { ok: false, error, channels: [] };
  }
}

/** 单渠道测试推送（Bark / 飞书 / Telegram 之一）；不影响 last_sent_date，也不要求渠道已启用。 */
export async function testReminderChannelAction(channel: string): Promise<ChannelTestResult> {
  const name = typeof channel === "string" ? channel : "";
  try {
    if (name !== "Bark" && name !== "飞书" && name !== "Telegram") {
      return { ok: false, name, error: "渠道无效" };
    }
    const config = loadReminderChannelConfig(getDocumentsDB());
    if (!config) return { ok: false, name, error: "渠道配置不可用" };
    const missing =
      (name === "Bark" && (config.Bark.URL.trim() === "" || config.Bark.Key.trim() === "")) ||
      (name === "飞书" && config.FeishuWebhook.trim() === "") ||
      (name === "Telegram" && (config.TGToken.trim() === "" || config.TGChatID.trim() === ""));
    if (missing) return { ok: false, name, error: `${name} 尚未配置完整（地址/Key/Webhook/Token 请先保存）` };
    const outcome = await sendChannel(config, name, REMINDER_TITLE, "这是一条测试通知：证件到期提醒渠道工作正常。");
    if (outcome.status !== "成功") {
      return { ok: false, name, error: outcome.error || `测试推送未确认送达（${outcome.status}）` };
    }
    return { ok: true, name, status: outcome.status };
  } catch (e) {
    return { ok: false, name, error: e instanceof Error ? e.message : "操作失败" };
  }
}

/**
 * 一次性从行情设置导入渠道配置（整行覆盖当前证件夹渠道配置，含空值清空）。
 * 行情库不可用时返回 ok:false，现有配置保持不变。
 */
export async function importChannelsFromStocksAction(): Promise<ChannelsImportResult> {
  try {
    const db = getDocumentsDB();
    const result = await importChannelsFromStocks(db);
    if (!result.ok) return { ok: false, error: `从行情设置导入失败：${result.error}` };
    revalidatePath("/documents/settings");
    return { ok: true, channels: summarizeChannels(result.config), config: result.config };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "操作失败" };
  }
}

/** 立即执行一次到期检查：忽略开关/小时/当日去重，但聚合失败（无渠道成功）不会写 last_sent_date。 */
export async function runReminderNowAction(): Promise<ReminderRunActionResult> {
  try {
    const result = await runDocumentExpiryCheck(getDocumentsDB(), { force: true });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "操作失败" };
  }
}
