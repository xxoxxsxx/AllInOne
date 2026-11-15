import assert from "node:assert/strict";
import { test } from "node:test";

import {
  remindersTodayPendingCount,
  shanghaiDayRange,
  stocksAlertsTodayCount,
} from "../src/lib/home-stats.ts";
import { openDB } from "../src/modules/stocks/store.ts";
import type { ScheduleLike } from "../src/lib/reminders/schedules.ts";

// 2026-05-10 10:00 北京时间（周日）
const NOW = Date.parse("2026-05-10T10:00:00+08:00");

function schedule(overrides: Partial<ScheduleLike>): ScheduleLike {
  return {
    id: 1,
    reminderId: 1,
    kind: "once",
    at: null,
    startAt: null,
    intervalSeconds: null,
    total: null,
    sent: 0,
    cron: null,
    nextAt: null,
    enabled: true,
    missedAt: null,
    ...overrides,
  };
}

test("shanghaiDayRange 按 +08:00 划分当天", () => {
  const { startMs, endMs } = shanghaiDayRange(NOW);
  assert.equal(startMs, Date.parse("2026-05-10T00:00:00+08:00"));
  assert.equal(endMs, startMs + 86400000);
});

test("今日待办提醒：once 调度", () => {
  const laterToday = NOW + 3600_000;
  const tomorrow = NOW + 26 * 3600_000;
  assert.equal(remindersTodayPendingCount([schedule({ kind: "once", at: laterToday })], NOW), 1);
  assert.equal(
    remindersTodayPendingCount([schedule({ kind: "once", at: NOW - 3600_000 })], NOW),
    1,
    "今天已到点但未发送（宽限期内待补发）仍算待办",
  );
  assert.equal(remindersTodayPendingCount([schedule({ kind: "once", at: laterToday, sent: 1 })], NOW), 0);
  assert.equal(remindersTodayPendingCount([schedule({ kind: "once", at: laterToday, missedAt: laterToday })], NOW), 0);
  assert.equal(remindersTodayPendingCount([schedule({ kind: "once", at: tomorrow })], NOW), 0);
  assert.equal(remindersTodayPendingCount([schedule({ kind: "once", at: null })], NOW), 0);
  assert.equal(remindersTodayPendingCount([schedule({ enabled: false, at: laterToday })], NOW), 0);
});

test("今日待办提醒：interval 调度", () => {
  const daily: ScheduleLike = schedule({
    kind: "interval",
    startAt: Date.parse("2026-05-09T10:00:00+08:00"),
    intervalSeconds: 86400,
    total: 3,
    sent: 1,
    nextAt: NOW - 1800_000,
  });
  assert.equal(remindersTodayPendingCount([daily], NOW), 1, "今天尚有未发送槽位");
  assert.equal(remindersTodayPendingCount([{ ...daily, sent: 3, nextAt: null }], NOW), 0, "槽位全部处理完不算待办");
  assert.equal(remindersTodayPendingCount([{ ...daily, nextAt: NOW + 48 * 3600_000 }], NOW), 0, "下一槽位在后天");
  assert.equal(remindersTodayPendingCount([{ ...daily, nextAt: null }], NOW), 1, "next_at 为空时按 start_at + sent 推导");
});

test("今日待办提醒：cron 调度", () => {
  const cronBase = { kind: "cron" as const, cron: "0 9 * * *" };
  assert.equal(remindersTodayPendingCount([schedule({ ...cronBase, nextAt: NOW + 2 * 3600_000 })], NOW), 1);
  assert.equal(remindersTodayPendingCount([schedule({ ...cronBase, nextAt: NOW - 600_000 })], NOW), 1, "已到期待触发算待办");
  assert.equal(remindersTodayPendingCount([schedule({ ...cronBase, nextAt: NOW + 48 * 3600_000 })], NOW), 0);
  assert.equal(remindersTodayPendingCount([schedule({ ...cronBase, nextAt: null })], NOW), 0);
});

test("今日股票触发：按北京时间当天统计，秒级比较无视毫秒小数", () => {
  const db = openDB(undefined, ":memory:");
  try {
    // notifications.run_id 引用 runs；仅测计数逻辑，关外键后插入最小行。
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(
      "insert into notifications (run_id, symbol, price, quote_at, levels, status, created_at) values (1, '600519', '100.00', '2026-05-10T01:00:00Z', '[]', '成功', ?)",
    );
    insert.run(new Date(Date.parse("2026-05-10T09:30:00+08:00")).toISOString()); // 今天
    insert.run(new Date(Date.parse("2026-05-09T23:00:00+08:00")).toISOString()); // 昨天
    insert.run(new Date(Date.parse("2026-05-10T00:00:01+08:00")).toISOString()); // 今天 00:00:01，毫秒小数
    insert.run(new Date(Date.parse("2026-05-11T08:00:00+08:00")).toISOString()); // 明天
    assert.equal(stocksAlertsTodayCount(db, NOW), 2);
  } finally {
    db.close();
  }
});
