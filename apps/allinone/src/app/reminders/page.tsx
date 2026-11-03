import Link from "next/link";

import { getRemindersDB, listReminders, type ReminderView, type ScheduleView } from "@/lib/reminders/store";
import { getModulePolicy } from "@/lib/channels/module-policy";
import { ReminderPushSettings } from "./push-settings";

import { RemindersClient, type ReminderCard, type ReminderStatus } from "./reminders-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "提醒事项",
};

/** 单条调度是否还有未来触发（供排序与状态徽章）。 */
function schedulePending(s: ScheduleView): string | null {
  if (!s.enabled) return null;
  if (s.kind === "once") return s.sent >= 1 || s.missedAt !== null ? null : s.at;
  if (s.kind === "interval") return s.total !== null && s.sent >= s.total ? null : s.nextAt;
  return s.nextAt;
}

function reminderStatus(r: ReminderView): ReminderStatus {
  if (!r.enabled) return "paused";
  if (r.schedules.some((s) => s.kind === "once" && s.missedAt !== null)) return "missed";
  const allDone =
    r.schedules.length > 0 &&
    r.schedules.every((s) => {
      if (s.kind === "once") return s.sent >= 1 || s.missedAt !== null;
      if (s.kind === "interval") return s.total !== null && s.sent >= s.total;
      return s.nextAt === null;
    });
  if (allDone) return "done";
  return "active";
}

/** 组装卡片视图：下次触发（最早未处理时间）与状态徽章在服务端算好，客户端只做展示与操作。 */
function toCard(r: ReminderView): ReminderCard {
  const pending = r.schedules
    .filter((s) => r.enabled)
    .map(schedulePending)
    .filter((v): v is string => v !== null)
    .sort();
  return {
    id: r.id,
    text: r.text,
    enabled: r.enabled,
    images: r.images.map((img) => ({
      id: img.id,
      storedName: img.storedName,
      originalName: img.originalName,
      mime: img.mime,
      size: img.size,
    })),
    schedules: r.schedules.map((s) => ({
      id: s.id,
      kind: s.kind,
      at: s.at,
      startAt: s.startAt,
      intervalSeconds: s.intervalSeconds,
      total: s.total,
      sent: s.sent,
      cron: s.cron,
      nextAt: s.nextAt,
      enabled: s.enabled,
      missedAt: s.missedAt,
    })),
    nextAt: pending[0] ?? null,
    status: reminderStatus(r),
  };
}

export default function RemindersPage() {
  const reminders = listReminders(getRemindersDB()).map(toCard);
  // 排序：启用中的按下次触发时间升序（无下次触发的靠后），已暂停的放最后。
  reminders.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.nextAt === null && b.nextAt === null) return b.id - a.id;
    if (a.nextAt === null) return 1;
    if (b.nextAt === null) return -1;
    return a.nextAt.localeCompare(b.nextAt);
  });
  return (
    <main className="rem-page">
      <Link href="/" className="rem-back">← 工具箱</Link>
      <ReminderPushSettings initial={getModulePolicy(getRemindersDB(), "reminders")} />
      <RemindersClient initialReminders={reminders} />
    </main>
  );
}
