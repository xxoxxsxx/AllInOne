import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyScheduleUpdates,
  contentTypeOfImage,
  createReminder,
  deleteReminder,
  deleteReminderImage,
  getReminder,
  isValidStoredImageName,
  listFireLog,
  listReminders,
  listRetryDueSchedules,
  listRunSchedules,
  logFire,
  normalizeSchedule,
  openRemindersDB,
  readReminderAttachment,
  removeAttachmentDir,
  saveReminderImage,
  setReminderEnabled,
  setScheduleRetry,
  updateReminder,
} from "../src/lib/reminders/store.ts";
import type { ScheduleUpdate } from "../src/lib/reminders/schedules.ts";

// 图片校验按文件头判定：8 字节 PNG 签名 / 3 字节 JPEG 魔数即可通过内容校验。
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** 独立临时 DATA_DIR（附件落盘用）+ 内存库；返回还原函数。 */
function withTempDataDir(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reminders-store-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  return () => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
}

function scheduleRow(db: ReturnType<typeof openRemindersDB>, reminderId: number) {
  return (db.prepare("SELECT * FROM reminder_schedules WHERE reminder_id=?").all(reminderId) as any[]).map((r) => ({
    kind: r.kind,
    at: r.at,
    next_at: r.next_at,
    sent: r.sent,
    cron: r.cron,
  }));
}

test("create/get roundtrip normalizes all three schedule kinds", () => {
  const db = openRemindersDB();
  const t = new Date(2026, 2, 5, 9, 0);
  const id = createReminder(db, {
    text: "  交物业费  ",
    schedules: [
      { kind: "once", at: t },
      { kind: "interval", startAt: t, intervalSeconds: 3600, total: 4 },
      { kind: "cron", cron: "0 9 * * 1" },
    ],
  });
  const view = getReminder(db, id);
  assert.ok(view);
  assert.equal(view!.text, "交物业费", "text is trimmed");
  assert.equal(view!.schedules.length, 3);
  const [once, interval, cron] = view!.schedules;
  assert.equal(once!.kind, "once");
  assert.equal(once!.at, new Date(t).toISOString());
  assert.equal(interval!.nextAt, interval!.startAt, "interval pointer starts at startAt");
  assert.equal(interval!.total, 4);
  assert.equal(cron!.cron, "0 9 * * 1");
  assert.ok(cron!.nextAt !== null, "cron next_at precomputed at creation");
  const parsed = Date.parse(cron!.nextAt!);
  assert.ok(Number.isFinite(parsed) && parsed > Date.now() - 86400_000);
});

test("createReminder rejects invalid input with Chinese errors and writes nothing", () => {
  const db = openRemindersDB();
  const cases: Array<[any, RegExp]> = [
    [{ text: "   " }, /提醒文字不能为空/],
    [{ text: "x".repeat(2001) }, /不能超过 2000 字/],
    [{ text: "ok", schedules: [{ kind: "once" }] }, /单次时间不能为空/],
    [{ text: "ok", schedules: [{ kind: "interval", startAt: new Date(), intervalSeconds: 30, total: 2 }] }, /间隔时长须为 60～/],
    [{ text: "ok", schedules: [{ kind: "interval", startAt: new Date(), intervalSeconds: 3600, total: 0 }] }, /间隔次数须为 1～/],
    [{ text: "ok", schedules: [{ kind: "cron", cron: "99 * * * *" }] }, /cron 表达式无效/],
    [{ text: "ok", schedules: [{ kind: "weekly" }] }, /调度类型无效/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => createReminder(db, input), pattern);
  }
  assert.deepEqual(listReminders(db), [], "failed creates must roll back completely");
});

test("normalizeSchedule parses datetime-local strings as server-local time", () => {
  const n = new Date(2026, 2, 5, 8, 0).getTime();
  const once = normalizeSchedule({ kind: "once", at: "2026-03-05T09:00" }, n);
  assert.equal(once.at, new Date(2026, 2, 5, 9, 0).toISOString());
  const cron = normalizeSchedule({ kind: "cron", cron: "0 9 * * *" }, n);
  assert.equal(cron.nextAt, new Date(2026, 2, 5, 9, 0).toISOString());
  const never = normalizeSchedule({ kind: "cron", cron: "0 0 31 2 *" }, n);
  assert.equal(never.nextAt, null, "never-firing cron stays dormant by design");
});

test("update/enable/delete lifecycle keeps schedules and attachments consistent", () => {
  const restore = withTempDataDir();
  try {
    const db = openRemindersDB();
    const id = createReminder(db, { text: "旧文字", schedules: [{ kind: "once", at: new Date(2026, 2, 5, 9, 0) }] });
    const image = saveReminderImage(db, id, PNG_BYTES, "image/png", "缴费截图.png");
    assert.ok(image.storedName.endsWith(".png"));

    updateReminder(db, id, { text: "新文字", enabled: true, schedules: [{ kind: "cron", cron: "30 8 * * *" }] });
    const updated = getReminder(db, id)!;
    assert.equal(updated.text, "新文字");
    assert.equal(updated.schedules.length, 1);
    assert.equal(updated.schedules[0]!.cron, "30 8 * * *");
    assert.equal(updated.images.length, 1, "images survive text/schedule updates");

    setReminderEnabled(db, id, false);
    assert.equal(getReminder(db, id)!.enabled, false);
    setReminderEnabled(db, id, true);

    const images = deleteReminder(db, id);
    assert.equal(images.length, 1);
    assert.equal(getReminder(db, id), null);
    assert.deepEqual(listReminders(db), []);
  } finally {
    restore();
  }
});

test("saveReminderImage validates real content and enforces the 12-image cap", () => {
  const restore = withTempDataDir();
  try {
    const db = openRemindersDB();
    const id = createReminder(db, { text: "带图提醒" });
    for (let i = 0; i < 12; i++) saveReminderImage(db, id, PNG_BYTES, "image/png", `图${i}.png`);
    assert.throws(() => saveReminderImage(db, id, PNG_BYTES, "image/png", "第13张.png"), /最多 12 张图片/);
    assert.throws(() => saveReminderImage(db, id, JPEG_BYTES, "image/png", "伪装.png"), /内容与格式不符/, "declared mime must match file header");
    assert.throws(() => saveReminderImage(db, id, Buffer.from("文本内容"), "text/plain", "a.txt"), /不支持的图片格式/);
    assert.equal(getReminder(db, id)!.images.length, 12);

    const removed = deleteReminderImage(db, id, getReminder(db, id)!.images[0]!.id)!;
    assert.equal(removed.storedName.length > 0, true);
    assert.equal(getReminder(db, id)!.images.length, 11);

    const first = getReminder(db, id)!.images[0]!;
    const bytes = readReminderAttachment(id, first.storedName);
    assert.ok(bytes && bytes.equals(PNG_BYTES));
    assert.equal(readReminderAttachment(id, "../../etc/passwd"), null, "path traversal is rejected");
    assert.equal(isValidStoredImageName("../evil"), false);
    assert.equal(contentTypeOfImage(first.storedName), "image/png");
    removeAttachmentDir(id);
  } finally {
    restore();
  }
});

test("logFire writes structured rows and listFireLog filters by schedule", () => {
  const db = openRemindersDB();
  const id1 = createReminder(db, { text: "A", schedules: [{ kind: "once", at: new Date(2026, 2, 5, 9, 0) }] });
  const id2 = createReminder(db, { text: "B", schedules: [{ kind: "once", at: new Date(2026, 2, 5, 9, 0) }] });
  const sched1 = getReminder(db, id1)!.schedules[0]!.id;
  const sched2 = getReminder(db, id2)!.schedules[0]!.id;
  logFire(db, {
    scheduleId: sched1,
    scheduledAt: "2026-03-05T01:00:00.000Z",
    status: "sent",
    detail: "推送成功",
    channelResults: [{ name: "Bark", status: "成功", error: "" }],
    attemptedAt: "2026-03-05T01:00:01.000Z",
  });
  logFire(db, { scheduleId: sched2, scheduledAt: "2026-03-05T01:00:00.000Z", status: "missed", detail: "错过宽限期" });

  const all = listFireLog(db);
  assert.equal(all.length, 2);
  assert.equal(all[0]!.scheduleId, sched2, "newest first");
  assert.deepEqual(all[1]!.channelResults, [{ name: "Bark", status: "成功", error: "" }]);
  const only1 = listFireLog(db, sched1);
  assert.equal(only1.length, 1);
  assert.equal(only1[0]!.status, "sent");
});

test("run/retry helpers drive the scheduler view correctly", () => {
  const db = openRemindersDB();
  const base = new Date(2026, 2, 5, 9, 0).getTime();
  const enabledId = createReminder(db, {
    text: "在跑",
    schedules: [{ kind: "interval", startAt: new Date(base), intervalSeconds: 60, total: 3 }],
  });
  const disabledReminder = createReminder(db, { text: "停用提醒", enabled: false, schedules: [{ kind: "once", at: new Date(base) }] });
  const pausedScheduleId = createReminder(db, {
    text: "暂停调度",
    schedules: [{ kind: "once", at: new Date(base), enabled: false }],
  }).valueOf();
  assert.ok(pausedScheduleId > 0);

  assert.equal(listRunSchedules(db).length, 1, "disabled reminders and paused schedules are invisible to the tick");
  assert.equal(listRunSchedules(db)[0]!.schedule.reminderId, enabledId);
  assert.equal(disabledReminder > 0, true);

  const scheduleId = listRunSchedules(db)[0]!.schedule.id;
  const updates: ScheduleUpdate[] = [{ id: scheduleId, next_at: base + 120_000, sent: 1 }];
  applyScheduleUpdates(db, updates, base);
  const after = listRunSchedules(db)[0]!.schedule;
  assert.equal(after.sent, 1);
  assert.equal(after.nextAt, base + 120_000);

  setScheduleRetry(db, scheduleId, { retryAt: base + 60_000, retryCount: 1, scheduledAt: base, catchup: true });
  const due = listRetryDueSchedules(db, base);
  assert.deepEqual(due, [], "retry not yet due");
  const dueNow = listRetryDueSchedules(db, base + 61_000);
  assert.equal(dueNow.length, 1);
  assert.equal(dueNow[0]!.retryCount, 1);
  assert.equal(dueNow[0]!.catchup, true);
  assert.equal(dueNow[0]!.scheduledAt, base);

  setScheduleRetry(db, scheduleId, null);
  assert.deepEqual(listRetryDueSchedules(db, base + 61_000), [], "cleared retry state disappears");
});
