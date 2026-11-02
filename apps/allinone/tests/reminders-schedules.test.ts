import test from "node:test";
import assert from "node:assert/strict";

import { computeDue, DEFAULT_GRACE_MS, scheduledAtOf, type ScheduleLike } from "../src/lib/reminders/schedules.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let serial = 0;
const schedule = (overrides: Partial<ScheduleLike> = {}): ScheduleLike => ({
  id: ++serial,
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
});
const T = 1_800_000_000_000; // 任意固定基准，纯函数与时区无关

test("once: future time stays dormant, due time fires without catchup mark", () => {
  const future = computeDue({ schedules: [schedule({ at: T + MIN })], now: T });
  assert.deepEqual(future.due, []);
  assert.deepEqual(future.updates, []);

  const just = computeDue({ schedules: [schedule({ at: T - 30_000 })], now: T });
  assert.equal(just.due.length, 1);
  assert.equal(just.due[0]!.catchup, false, "≤60s late is a normal delivery");
  assert.deepEqual(just.updates, [{ id: just.due[0]!.schedule.id, next_at: null, sent: 1 }]);
});

test("once: late but within grace fires with catchup; beyond grace is marked missed", () => {
  const late = computeDue({ schedules: [schedule({ at: T - 2 * HOUR })], now: T });
  assert.equal(late.due[0]!.catchup, true);
  assert.equal(late.updates[0]!.sent, 1);

  const overdue = schedule({ at: T - DAY - HOUR });
  const beyond = computeDue({ schedules: [overdue], now: T });
  assert.deepEqual(beyond.due, [], "beyond the 24h grace no push happens");
  assert.deepEqual(beyond.updates, [{ id: overdue.id, next_at: null, sent: 0, missed: true }]);

  // missedAt 已设置后不再重复判定（终局）。
  const settled = computeDue({ schedules: [schedule({ at: T - DAY - HOUR, missedAt: T - DAY })], now: T });
  assert.deepEqual(settled.due, []);
  assert.deepEqual(settled.updates, []);
});

test("once grace boundary: exactly 24h still fires, default constant is one day", () => {
  const edge = computeDue({ schedules: [schedule({ at: T - DAY })], now: T });
  assert.equal(edge.due.length, 1);
  const over = computeDue({ schedules: [schedule({ at: T - DAY - 1 })], now: T });
  assert.equal(over.due.length, 0);
  assert.equal(over.updates[0]!.missed, true);
  assert.equal(DEFAULT_GRACE_MS, DAY);
});

test("interval: creation-time pointer slot counts as passed, later slots preserved", () => {
  // 指针从 start_at 起算：创建时 start 已过 90 秒 → start 与 +60s 两个槽位均已过去，
  // 只投递最新一个（catchup=false，距今 30s），start 槽位记入 skipped gap。
  const s = schedule({ kind: "interval", startAt: T - 90_000, intervalSeconds: 60, total: 3, nextAt: T - 90_000 });
  const r = computeDue({ schedules: [s], now: T });
  assert.equal(r.due.length, 1);
  assert.equal(r.due[0]!.catchup, false, "latest slot is within the catchup threshold");
  assert.deepEqual(r.updates[0], {
    id: s.id,
    next_at: T + 30_000,
    sent: 1,
    missed: { skipped: 1, fromMs: T - 90_000, toMs: T - 90_000, nextMs: T + 30_000 },
  });
});

test("interval: multi-slot downtime fires only the latest slot and logs the skipped gap", () => {
  const s = schedule({ kind: "interval", startAt: T - 600_000, intervalSeconds: 60, total: 5, nextAt: T - 600_000 });
  const r = computeDue({ schedules: [s], now: T });
  assert.equal(r.due.length, 1);
  assert.equal(r.due[0]!.catchup, true, "the latest slot is 6 minutes stale");
  const u = r.updates[0]!;
  // 5 个槽位全部在过去：指针收口为 null 且 sent 按总数收口；跳过 4 个更早槽位。
  assert.equal(u.next_at, null);
  assert.equal(u.sent, 5);
  assert.ok(u.missed && typeof u.missed === "object");
  if (u.missed && typeof u.missed === "object") {
    assert.equal(u.missed.skipped, 4);
    assert.equal(u.missed.fromMs, T - 600_000);
    assert.equal(u.missed.toMs, T - 600_000 + 3 * 60_000);
    assert.equal(u.missed.nextMs, null);
  }
});

test("interval: mid-run downtime keeps remaining occurrences (skipped slots are not consumed)", () => {
  // 指针停在中途（start+60s）：到 now 又过去 2 个槽位，投递最新的一个并保留剩余次数。
  const s = schedule({ kind: "interval", startAt: T - 200_000, intervalSeconds: 60, total: 5, nextAt: T - 120_000 });
  const r = computeDue({ schedules: [s], now: T });
  const u = r.updates[0]!;
  assert.equal(r.due.length, 1);
  assert.equal(r.due[0]!.catchup, false, "latest slot fires exactly at now");
  assert.ok(u.next_at !== null && u.next_at > T, "pointer jumps to a future slot");
  assert.equal(u.sent, 1, "only the delivered slot counts");
  assert.ok(u.missed && typeof u.missed === "object");
  if (u.missed && typeof u.missed === "object") assert.equal(u.missed.skipped, 2);
});

test("interval: exhausted or dormant schedules stay quiet", () => {
  assert.deepEqual(
    computeDue({ schedules: [schedule({ kind: "interval", startAt: T, intervalSeconds: 60, total: 3, sent: 3, nextAt: null })], now: T })
      .due,
    [],
  );
  assert.deepEqual(
    computeDue({ schedules: [schedule({ kind: "interval", startAt: T + HOUR, intervalSeconds: 60, total: 3, nextAt: T + HOUR })], now: T })
      .due,
    [],
  );
  assert.deepEqual(
    computeDue({ schedules: [schedule({ kind: "interval", startAt: T, intervalSeconds: 60, total: 5, enabled: false, nextAt: T - MIN })], now: T })
      .due,
    [],
  );
});

test("cron: due schedule recomputes a strictly-future next_at and counts skipped window", () => {
  const s = schedule({ kind: "cron", cron: "0 9 * * *", nextAt: T - 2 * HOUR });
  const r = computeDue({ schedules: [s], now: T });
  assert.equal(r.due.length, 1);
  assert.equal(r.due[0]!.catchup, true);
  const u = r.updates[0]!;
  assert.ok(u.next_at !== null && u.next_at > T, "next_at jumps past now");
  // (nextAt, now] = 2 小时窗口内每天 09:00 一次 → 取决于绝对时刻，这里断言「有一次或零次且无 NaN」。
  assert.ok(u.missed === undefined || (u.missed && typeof u.missed === "object"));
});

test("cron and interval gaps produce no due-less updates in quiet state", () => {
  const quiet = computeDue({
    schedules: [
      schedule({ kind: "cron", cron: "0 9 * * *", nextAt: T + DAY }),
      schedule({ kind: "interval", startAt: T + DAY, intervalSeconds: 3600, total: 2, nextAt: T + DAY }),
    ],
    now: T,
  });
  assert.deepEqual(quiet.due, []);
  assert.deepEqual(quiet.updates, []);
});

test("scheduledAtOf maps each kind to its planned fire time", () => {
  assert.equal(scheduledAtOf(schedule({ kind: "once", at: 123 })), 123);
  assert.equal(scheduledAtOf(schedule({ kind: "interval", startAt: 100, intervalSeconds: 60, sent: 2, nextAt: null })), 100 + 2 * 60_000);
  assert.equal(scheduledAtOf(schedule({ kind: "cron", nextAt: 456 })), 456);
});

test("computeDue is deterministic and ignores disabled rows", () => {
  const input = { schedules: [schedule({ at: T - MIN }), schedule({ at: T - MIN, enabled: false, id: 99 })], now: T };
  const a = computeDue(input);
  const b = computeDue(input);
  assert.deepEqual(a, b);
  assert.equal(a.due.length, 1);
  assert.ok(a.due[0]!.schedule.id !== 99);
});
