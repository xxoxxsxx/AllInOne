"use server";

// 提醒事项 Server Actions：UI 全部变更入口；返回 { ok, ... } 供客户端组件处理，不向客户端抛异常。
// 图片上传走同一个保存动作（FormData 携带新图片文件，key="images"）：
// 服务端逐张做文件头校验（JPEG/PNG/WebP，≤10MiB），并执行「每条提醒 ≤12 张」上限。

import { revalidatePath } from "next/cache";
import { saveModulePolicy, type ModulePolicy } from "@/lib/channels/module-policy";

import {
  createReminder,
  deleteReminder,
  deleteReminderImage,
  getRemindersDB,
  MAX_IMAGES_PER_REMINDER,
  removeAttachmentDir,
  saveReminderImage,
  setReminderEnabled,
  updateReminder,
  type ReminderInput,
  type ScheduleInput,
} from "@/lib/reminders/store";
import { sendReminderTest } from "@/lib/reminders/run";
import type { ChannelSendResult } from "@/lib/documents/reminders-run";

export type ActionResult = { ok: true } | { ok: false; error: string };
export type SaveResult = { ok: true; id: number } | { ok: false; error: string };
export type TestResult =
  | { ok: true; aggregate: string; channels: ChannelSendResult[] }
  | { ok: false; error: string; channels: ChannelSendResult[] };

/** 保存入参：编辑时携带 id；调度与图片校验全部在服务端重做（不信任客户端）。 */
export type SaveReminderPayload = ReminderInput & { id?: number };

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "操作失败" };
}

function num(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("参数无效");
  return n;
}

function revalidate(): void {
  revalidatePath("/reminders");
  revalidatePath("/");
}

/**
 * 保存提醒（新建或编辑）：文字 + 多条调度 + 新图片（FormData "images"）。
 * 编辑时调度整体替换（按提交内容重新起算）；已有图片不受影响，删除走 deleteReminderImageAction。
 */
export async function saveReminderAction(payload: SaveReminderPayload, fd: FormData): Promise<SaveResult> {
  try {
    const input: ReminderInput = {
      text: typeof payload?.text === "string" ? payload.text : "",
      enabled: payload?.enabled !== false,
      schedules: Array.isArray(payload?.schedules) ? payload.schedules : [],
    };
    const db = getRemindersDB();
    const editId =
      payload && typeof payload.id === "number" && Number.isInteger(payload.id) && payload.id > 0 ? num(payload.id) : null;
    const id = editId !== null ? (() => { updateReminder(db, editId, input); return editId; })() : createReminder(db, input);

    const files = fd ? fd.getAll("images").filter((v): v is File => v instanceof File && v.size > 0) : [];
    if (files.length > 0) {
      const existing = db.prepare("SELECT COUNT(*) AS n FROM reminder_images WHERE reminder_id=?").get(id) as { n: number };
      if (existing.n + files.length > MAX_IMAGES_PER_REMINDER) {
        throw new Error(`每条提醒最多 ${MAX_IMAGES_PER_REMINDER} 张图片`);
      }
      for (const file of files) {
        const mime = file.type || "";
        const data = Buffer.from(await file.arrayBuffer());
        saveReminderImage(db, id, data, mime, file.name || "图片");
      }
    }
    revalidate();
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteReminderAction(id: number): Promise<ActionResult> {
  try {
    deleteReminder(getRemindersDB(), num(id));
    revalidate();
    try {
      removeAttachmentDir(num(id));
    } catch (cleanupError) {
      console.error("提醒附件目录清理失败", cleanupError);
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function saveReminderPushPolicyAction(policy: ModulePolicy): Promise<ActionResult> {
  try {
    saveModulePolicy(getRemindersDB(), "reminders", { enabled: policy?.enabled === true, bark: policy?.bark === true, feishu: policy?.feishu === true, telegram: policy?.telegram === true });
    revalidate(); return { ok: true };
  } catch (e) { return fail(e); }
}

export async function setReminderEnabledAction(id: number, enabled: boolean): Promise<ActionResult> {
  try {
    setReminderEnabled(getRemindersDB(), num(id), enabled === true);
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteReminderImageAction(reminderId: number, imageId: number): Promise<ActionResult> {
  try {
    const removed = deleteReminderImage(getRemindersDB(), num(reminderId), num(imageId));
    if (!removed) throw new Error("图片不存在或已删除");
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** 立即测试：按真实投递路径发一条测试消息（文字 + Telegram 首图），不改调度状态。 */
export async function testReminderAction(id: number): Promise<TestResult> {
  try {
    const result = await sendReminderTest(num(id));
    if (!result.ok) {
      return { ok: false, error: result.error, channels: [] };
    }
    return { ok: true, aggregate: result.aggregate, channels: result.channels };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "操作失败", channels: [] };
  }
}
