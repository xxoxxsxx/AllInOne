"use server";

// 证件到期提醒 Server Actions：供提醒设置面板（settings/reminders-settings.tsx）调用。
// 与 documents/actions.ts 分离，避免改动既有证件动作；全部返回 { ok, ... }，不向客户端抛异常。

import { revalidatePath } from "next/cache";

import { getDocumentsDB } from "@/lib/documents/db";
import { getReminderSettings, REMINDER_TITLE, saveReminderSettings, type ReminderSettings } from "@/lib/documents/reminders";
import {
  defaultBarkSender,
  loadBarkConfigFromStocks,
  runDocumentExpiryCheck,
  type ReminderRunResult,
} from "@/lib/documents/reminders-run";

export type ReminderActionResult =
  | { ok: true; settings: ReminderSettings }
  | { ok: false; error: string };

export type ReminderTestResult =
  | { ok: true; status: string; error: string }
  | { ok: false; error: string };

export type ReminderRunActionResult =
  | { ok: true; result: ReminderRunResult }
  | { ok: false; error: string };

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "操作失败" };
}

/** 当前提醒设置（含 last_sent_date），供面板状态展示。 */
export async function getReminderSettingsAction(): Promise<ReminderActionResult> {
  try {
    return { ok: true, settings: getReminderSettings(getDocumentsDB()) };
  } catch (e) {
    return fail(e);
  }
}

/** 保存开关与提醒时刻（Asia/Shanghai 小时 0–23）。 */
export async function saveReminderSettingsAction(enabled: boolean, hour: number): Promise<ReminderActionResult> {
  try {
    const settings = saveReminderSettings(getDocumentsDB(), { enabled: enabled === true, hour });
    revalidatePath("/documents");
    revalidatePath("/documents/settings");
    return { ok: true, settings };
  } catch (e) {
    return fail(e);
  }
}

/** 发送一条测试推送；不影响 last_sent_date，也不依赖开关状态。 */
export async function testReminderAction(): Promise<ReminderTestResult> {
  try {
    const barkConfig = loadBarkConfigFromStocks();
    if (!barkConfig) {
      return { ok: false, error: "尚未配置 Bark：请先在「行情与通知设置」中启用并填写 Bark 地址和设备 Key" };
    }
    const outcome = await defaultBarkSender(barkConfig, REMINDER_TITLE, "这是一条测试通知：证件到期提醒渠道工作正常。");
    if (outcome.status !== "成功") {
      return { ok: false, error: outcome.error || `测试推送未确认送达（${outcome.status}）` };
    }
    return { ok: true, status: outcome.status, error: "" };
  } catch (e) {
    return fail(e);
  }
}

/** 立即执行一次到期检查：忽略开关/小时/当日去重，但推送失败不会写 last_sent_date。 */
export async function runReminderNowAction(): Promise<ReminderRunActionResult> {
  try {
    const result = await runDocumentExpiryCheck(getDocumentsDB(), { force: true });
    return { ok: true, result };
  } catch (e) {
    return fail(e);
  }
}
