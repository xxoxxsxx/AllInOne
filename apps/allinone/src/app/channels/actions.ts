"use server";

// 全局推送渠道中心 Server Actions：供 /channels 页面的渠道表单调用。
// 配置保存在 @/lib/channels/center（DATA_DIR/channels/channels.db），
// 证件夹与提醒事项共用这一份；与 stocks 的唯一交集是「从行情设置导入」这一一次性显式动作。
// 全部返回 { ok, ... } 并携带最新渠道摘要（绝不含机密），不向客户端抛异常。

import { revalidatePath } from "next/cache";

import { enabledChannels, sendChannel, type ChannelConfig } from "@/modules/stocks/notify";
import {
  clearGlobalChannel,
  getChannelConfig,
  saveChannelConfig,
  summarizeChannels,
  type ReminderChannelsInput,
  type ReminderChannelsSummary,
} from "@/lib/channels/center";
import { defaultChannelSender, dispatchToEnabledChannels } from "@/lib/documents/reminders-run";

export type ChannelsSaveResult =
  | { ok: true; channels: ReminderChannelsSummary; config: ChannelConfig }
  | { ok: false; error: string; channels: ReminderChannelsSummary };

export type ChannelTestResult =
  | { ok: true; name: string; status: string }
  | { ok: false; name: string; error: string };

export type ChannelsTestResult =
  | { ok: true; status: string; channels: Array<{ name: string; status: string; error: string }> }
  | { ok: false; error: string; channels: Array<{ name: string; status: string; error: string }> };

const TEST_BODY = "这是一条测试通知：全局推送渠道工作正常。";

function revalidateChannelPages(): void {
  revalidatePath("/channels");
  revalidatePath("/documents/settings");
}

/** 保存推送渠道配置（合并语义）：留空/缺省 = 保持现有值，开关按提交值应用。 */
export async function saveChannelsAction(input: ReminderChannelsInput): Promise<ChannelsSaveResult> {
  try {
    const config = saveChannelConfig(input ?? {});
    revalidateChannelPages();
    return { ok: true, channels: summarizeChannels(config), config };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "操作失败", channels: summarizeChannels(getChannelConfig()) };
  }
}

/** 清除指定渠道或代理的全部配置。 */
export async function clearChannelAction(name: string): Promise<ChannelsSaveResult> {
  try {
    if (name !== "Bark" && name !== "飞书" && name !== "Telegram" && name !== "代理") throw new Error("渠道无效");
    const config = clearGlobalChannel(name);
    revalidateChannelPages();
    return { ok: true, channels: summarizeChannels(config), config };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "操作失败", channels: summarizeChannels(getChannelConfig()) };
  }
}

/** 单渠道测试推送（Bark / 飞书 / Telegram 之一）；不要求渠道已启用，但要求配置完整。 */
export async function testChannelAction(channel: string): Promise<ChannelTestResult> {
  const name = typeof channel === "string" ? channel : "";
  try {
    if (name !== "Bark" && name !== "飞书" && name !== "Telegram") {
      return { ok: false, name, error: "渠道无效" };
    }
    const config = getChannelConfig();
    const missing =
      (name === "Bark" && (config.Bark.URL.trim() === "" || config.Bark.Key.trim() === "")) ||
      (name === "飞书" && config.FeishuWebhook.trim() === "") ||
      (name === "Telegram" && (config.TGToken.trim() === "" || config.TGChatID.trim() === ""));
    if (missing) return { ok: false, name, error: `${name} 尚未配置完整（地址/Key/Webhook/Token 请先保存）` };
    const outcome = await sendChannel(config, name, "⏰ 全局推送渠道", TEST_BODY);
    if (outcome.status !== "成功") {
      return { ok: false, name, error: outcome.error || `测试推送未确认送达（${outcome.status}）` };
    }
    return { ok: true, name, status: outcome.status };
  } catch (e) {
    return { ok: false, name, error: e instanceof Error ? e.message : "操作失败" };
  }
}

/** 向所有已启用渠道发送一条中性测试推送；不影响任何业务数据。 */
export async function testChannelsAction(): Promise<ChannelsTestResult> {
  try {
    const config = getChannelConfig();
    if (enabledChannels(config).length === 0) {
      return { ok: false, error: "尚未配置任何推送渠道：请先在下方启用并配置 Bark / 飞书 / Telegram 至少一个渠道", channels: [] };
    }
    const { aggregate, channels } = await dispatchToEnabledChannels(
      config,
      "⏰ 全局推送渠道",
      TEST_BODY,
      defaultChannelSender,
    );
    if (aggregate === "失败") {
      return { ok: false, error: "所有启用渠道均发送失败，请检查渠道配置", channels };
    }
    return { ok: true, status: aggregate, channels };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "操作失败", channels: [] };
  }
}
