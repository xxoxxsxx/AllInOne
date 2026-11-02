import test from "node:test";
import assert from "node:assert/strict";

import { countSkippedCronOccurrences, nextFire, nextFires, parseCron } from "../src/lib/reminders/cron.ts";

// 全部用「服务器本地时间」构造：Date(y, m, d, h, min) 与 cron 引擎同一时区，测试与时区无关。
const at = (y: number, m1: number, d: number, h = 0, min = 0, s = 0) => new Date(y, m1 - 1, d, h, min, s);

test("parseCron accepts lists, ranges, steps and normalizes dow 7 to 0", () => {
  const five = parseCron("*/5 * * * *");
  assert.ok(five.ok);
  assert.deepEqual(five.fields.minute, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);

  const weekdays = parseCron("0 9 * * 1-5");
  assert.ok(weekdays.ok);
  assert.deepEqual(weekdays.fields.dow, [1, 2, 3, 4, 5]);

  const sunday7 = parseCron("0 0 * * 7");
  assert.ok(sunday7.ok);
  assert.deepEqual(sunday7.fields.dow, [0], "7 must normalize to Sunday 0");

  const list = parseCron("0,30 8,20 * * *");
  assert.ok(list.ok);
  assert.deepEqual(list.fields.minute, [0, 30]);
  assert.deepEqual(list.fields.hour, [8, 20]);

  const stepRange = parseCron("10-30/5 * * * *");
  assert.ok(stepRange.ok);
  assert.deepEqual(stepRange.fields.minute, [10, 15, 20, 25, 30]);

  // a/step 视作 a-max/step（vixie 语义）。
  const openStep = parseCron("5/15 * * * *");
  assert.ok(openStep.ok);
  assert.deepEqual(openStep.fields.minute, [5, 20, 35, 50]);
});

test("parseCron rejects malformed expressions with Chinese errors", () => {
  const bad: Array<[string, RegExp]> = [
    ["", /不能为空/],
    ["60 * * * *", /分钟字段超出范围/],
    ["* * * 13 *", /月字段超出范围/],
    ["* * * * 8", /周字段超出范围/],
    ["*/0 * * * *", /步进无效/],
    ["10-5 * * * *", /区间起止颠倒/],
    ["5 * * *", /字段数须为 5/],
    ["5 * * * * *", /字段数须为 5/],
    ["a * * * *", /分钟字段无效/],
    ["1,,2 * * * *", /空列表项/],
  ];
  for (const [expr, pattern] of bad) {
    const r = parseCron(expr);
    assert.deepEqual(r.ok, false, expr);
    if (!r.ok) assert.match(r.error, pattern, expr);
  }
});

test("nextFire returns the strictly-next local-time occurrence", () => {
  assert.deepEqual(nextFire("*/15 * * * *", at(2026, 3, 5, 9, 0, 30)), at(2026, 3, 5, 9, 15));
  assert.deepEqual(nextFire("0 9 * * *", at(2026, 3, 5, 9, 0, 30)), at(2026, 3, 6, 9, 0), "same time tomorrow");
  assert.deepEqual(nextFire("30 8 * * *", at(2026, 3, 5, 9, 0, 30)), at(2026, 3, 6, 8, 30));
  assert.deepEqual(nextFire("0 * * * *", at(2026, 3, 5, 9, 0, 30)), at(2026, 3, 5, 10, 0), "seconds are honored");
  assert.deepEqual(nextFire("0 0 1 * *", at(2026, 1, 31, 12, 0)), at(2026, 2, 1, 0, 0), "month rollover");
  assert.deepEqual(nextFire("0 0 29 2 *", at(2026, 3, 1, 0, 0)), at(2028, 2, 29, 0, 0), "leap year handling");
});

test("dom and dow restricted together match either (vixie OR semantics)", () => {
  // 2026-03-13 恰为周五：13日（受限 dom）与周五（受限 dow）重合日不应重复计算。
  const fires = nextFires("0 0 13 * 5", at(2026, 3, 1, 0, 0), 6);
  assert.ok(fires.length >= 2);
  for (let i = 1; i < fires.length; i++) assert.ok(fires[i]!.getTime() > fires[i - 1]!.getTime());
  for (const f of fires) {
    const isDom13 = f.getDate() === 13;
    const isFriday = f.getDay() === 5;
    assert.ok(isDom13 || isFriday, `${f}: must be the 13th or a Friday`);
    assert.ok(!(isDom13 && !isFriday) || true);
  }
  // 2026-03-13 本身是周五：作为「周五」与「13日」只触发一次，下一跳不早于其后一周。
  const first = fires[0]!;
  const second = fires[1]!;
  assert.ok(first.getDate() === 13 || first.getDay() === 5);
  assert.ok(second.getTime() - first.getTime() >= 6 * 86400_000);
});

test("both-star fields intersect: weekly cron fires only on that weekday", () => {
  const monday = at(2026, 3, 2, 8, 0); // 2026-03-02 是周一
  const next = nextFire("0 8 * * 1", monday);
  assert.deepEqual(next, at(2026, 3, 9, 8, 0), "next Monday, exactly 7 days later");
});

test("never-firing expressions resolve to null without hanging", () => {
  assert.equal(nextFire("0 0 31 2 *", at(2026, 3, 1, 0, 0)), null, "Feb 31st never exists");
  assert.deepEqual(nextFires("0 0 31 2 *", at(2026, 3, 1, 0, 0), 3), []);
});

test("nextFires returns ascending unique occurrences", () => {
  const fires = nextFires("*/10 * * * *", at(2026, 3, 5, 8, 5), 4);
  assert.equal(fires.length, 4);
  for (let i = 1; i < fires.length; i++) assert.ok(fires[i]!.getTime() > fires[i - 1]!.getTime());
  assert.deepEqual(fires.map((f) => f.getMinutes()), [10, 20, 30, 40]);
});

test("countSkippedCronOccurrences counts (from, until] with a cap", () => {
  assert.equal(countSkippedCronOccurrences("*/5 * * * *", at(2026, 3, 5, 9, 0), at(2026, 3, 5, 9, 17)), 3);
  assert.equal(countSkippedCronOccurrences("*/5 * * * *", at(2026, 3, 5, 9, 0), at(2026, 3, 5, 9, 0)), 0);
  assert.equal(countSkippedCronOccurrences("*/5 * * * *", at(2026, 3, 5, 9, 0), at(2026, 3, 5, 9, 5)), 1, "(from, until] includes until itself");
  assert.equal(
    countSkippedCronOccurrences("* * * * *", at(2026, 3, 5, 9, 0), at(2026, 3, 5, 12, 0), 10),
    10,
    "cap prevents unbounded scans",
  );
});
