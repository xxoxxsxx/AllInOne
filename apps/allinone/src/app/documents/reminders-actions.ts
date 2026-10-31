"use server";

// 证件到期提醒 Server Actions：供提醒设置面板（settings/reminders-settings.tsx）调用。
// 与 documents/actions.ts 分离，避免改动既有证件动作；全部返回 { ok, ... }，不向客户端抛异常。
// 推送渠道复用行情（TickerSentry）设置的 Bark / 飞书 / Telegram 三个渠道及其启用开关。

import { revalidatePath } from "next/cache";

import { getDocumentsDB } from "@/lib/documents/db";
import { getReminderSettings, REMINDER_TITLE, saveReminderSettings, type ReminderSettings } from "@/lib/documents/reminders";
import { enabledChannels } from "@/modules/stocks/notify";
import {
  defaultChannelSender,
  dispatchToEnabledChannels,
  loadNotificationConfigFromStocks,
  runDocumentExpiryCheck,
  summarizeChannels,
  type ChannelSendResult,
  type ChannelSummary,
  type ReminderRunResult,
} from "@/lib/documents/reminders-run";

export type ReminderActionResult =
  | { ok: true; settings: ReminderSettings; channels: ChannelSummary[] }
  | { ok: false; error: string; channels: ChannelSummary[] };

export type ReminderTestResult =
  | { ok: true; status: string; channels: ChannelSendResult[] }
  | { ok: false; error: string; channels: ChannelSendResult[] };

export type ReminderRunActionResult =
  | { ok: true; result: ReminderRunResult }
  | { ok: false; error: string };

const NO_CHANNELS_ERROR =
  "尚未配置任何推送渠道：请先在「行情与通知设置（TickerSentry）」中启用并配置 Bark / 飞书 / Telegram 至少一个渠道";

function fail(error: unknown): { ok: false; error: string; channels: ChannelSummary[] } {
  return { ok: false, error: error instanceof Error ? error.message : "操作失败", channels: [] };
}

/** 当前提醒设置（含 last_sent_date）与各渠道摘要（绝不含机密），供面板状态展示。 */
export async function getReminderSettingsAction(): Promise<ReminderActionResult> {
  try {
    const settings = getReminderSettings(getDocumentsDB());
    const config = loadNotificationConfigFromStocks();
    return { ok: true, settings, channels: config ? summarizeChannels(config) : [] };
  } catch (e) {
    return fail(e);
  }
}

/** 保存开关与提醒时刻（Asia/Shanghai 小时 0–23）。 */
export async function saveReminderSettingsAction(enabled: boolean, hour: number): Promise<ReminderActionResult> {
  try {
    const settings = saveReminderSettings(getDocumentsDB(), { enabled: enabled === true, hour });
    const config = loadNotificationConfigFromStocks();
    revalidatePath("/documents");
    revalidatePath("/documents/settings");
    return { ok: true, settings, channels: config ? summarizeChannels(config) : [] };
  } catch (e) {
    return fail(e);
  }
}

/** 发送一条测试推送（走 Bark / 飞书 / Telegram 多渠道路径）；不影响 last_sent_date，也不依赖提醒开关。 */
export async function testReminderAction(): Promise<ReminderTestResult> {
  try {
    const config = loadNotificationConfigFromStocks();
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
      return { ok: false, error: "所有启用渠道均发送失败，请检查行情与通知设置", channels };
    }
    return { ok: true, status: aggregate, channels };
  } catch (e) {
    const error = e instanceof Error ? e.message : "操作失败";
    return { ok: false, error, channels: [] };
  }
}

/** 立即执行一次到期检查：忽略开关/小时/当日去重，但聚合失败（无渠道成功）不会写 last_sent_date。 */
export async function runReminderNowAction(): Promise<ReminderRunActionResult> {
  try {
    const result = await runDocumentExpiryCheck(getDocumentsDB(), { force: true });
    return { ok: true, result };
  } catch (e) {
    return fail(e);
  }
}
