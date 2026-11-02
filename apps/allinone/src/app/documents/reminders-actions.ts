"use server";

// 证件到期提醒 Server Actions：供提醒设置面板（settings/reminders-settings.tsx）调用。
// 与 documents/actions.ts 分离，避免改动既有证件动作；全部返回 { ok, ... }，不向客户端抛异常。
// 渠道配置保存在全局推送渠道中心（@/lib/channels/center，DATA_DIR/channels/channels.db），
// 经 reminders-channels 的兼容委托读取；渠道的保存/清除/测试/导入动作已迁至 /channels 页面
// （src/app/channels/actions.ts），这里只保留提醒设置、整体测试与立即检查。

import { revalidatePath } from "next/cache";

import { getDocumentsDB } from "@/lib/documents/db";
import {
  getReminderSettings,
  REMINDER_TITLE,
  saveReminderSettings,
  type ReminderSettings,
} from "@/lib/documents/reminders";
import { enabledChannels, type ChannelConfig } from "@/modules/stocks/notify";
import {
  loadReminderChannelConfig,
  summarizeChannels,
  summarizeReminderChannels,
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

export type ReminderTestResult =
  | { ok: true; status: string; channels: import("@/lib/documents/reminders-run").ChannelSendResult[] }
  | { ok: false; error: string; channels: import("@/lib/documents/reminders-run").ChannelSendResult[] };

export type ReminderRunActionResult =
  | { ok: true; result: ReminderRunResult }
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

/** 立即执行一次到期检查：忽略开关/小时/当日去重，但聚合失败（无渠道成功）不会写 last_sent_date。 */
export async function runReminderNowAction(): Promise<ReminderRunActionResult> {
  try {
    const result = await runDocumentExpiryCheck(getDocumentsDB(), { force: true });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "操作失败" };
  }
}
