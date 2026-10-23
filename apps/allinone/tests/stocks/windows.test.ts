// 调度窗口测试：跨午夜时段、起点对齐间隔、额度继承、重叠禁止、 occurrence 语义。
import assert from "node:assert/strict";
import { test } from "node:test";

import { occurrence, windowSummary, validWindow, windowsOverlap, windowDuration, windowStatus } from "../../src/modules/stocks/windows.ts";
import { openDB, queryWindows, listLevels } from "../../src/modules/stocks/store.ts";
import { zonedTime, parseClock, rfc3339Nano } from "../../src/modules/stocks/tz.ts";
import { nextFireForSchedule, nextWindowOccurrence } from "../../src/modules/stocks/next-fire.ts";

const WIN = { id: 1, start: 22 * 60, end: 2 * 60, interval: 5, max_alerts: 3, enabled: true }; // 22:00–02:00 跨午夜

function atNY(isoLocal: string): Date {
  // "2026-03-09T23:05" 之类的纽约墙钟 → UTC 时刻。
  const [date, time] = isoLocal.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return zonedTime("America/New_York", y, mo, d, h, mi)!;
}

test("跨午夜时段：23:05 落在 22:00–02:00 内，offset 按起点对齐", () => {
  const occ = occurrence(WIN, atNY("2026-03-09T23:05"), "America/New_York");
  assert.ok(occ.active);
  assert.equal(occ.offset, 65);
  assert.equal(occ.day, "2026-03-09");
});

test("跨午夜时段：01:30 属于前一日开始的时段", () => {
  const occ = occurrence(WIN, atNY("2026-03-10T01:30"), "America/New_York");
  assert.ok(occ.active);
  assert.equal(occ.offset, 210);
  assert.equal(occ.day, "2026-03-09");
});

test("终点不含：02:00 与 02:01 都不在时段内", () => {
  for (const t of ["2026-03-10T02:00", "2026-03-10T02:01"]) {
    const occ = occurrence(WIN, atNY(t), "America/New_York");
    assert.ok(!occ.active, t);
  }
});

test("同日非跨午夜时段 offset 与 day", () => {
  const w = { id: 2, start: 9 * 60 + 30, end: 16 * 60, interval: 30, max_alerts: 2, enabled: true };
  const occ = occurrence(w, atNY("2026-03-09T10:00"), "America/New_York");
  assert.ok(occ.active);
  assert.equal(occ.offset, 30);
  assert.equal(occ.day, "2026-03-09");
});

test("validWindow：间隔不得超过时段长度", () => {
  assert.ok(validWindow(WIN));
  assert.ok(!validWindow({ ...WIN, interval: 300 })); // 240 分钟时段，300 间隔非法
  assert.ok(!validWindow({ ...WIN, start: 60, end: 60 })); // 起止相同
});

test("重叠禁止：跨午夜时段与 01:00–03:00 冲突", () => {
  const other = { id: 3, start: 60, end: 180, interval: 5, max_alerts: 3, enabled: true };
  assert.ok(windowsOverlap(WIN, other));
  const later = { id: 4, start: 3 * 60, end: 5 * 60, interval: 5, max_alerts: 3, enabled: true };
  assert.ok(!windowsOverlap(WIN, later));
});

test("额度继承：档位 MaxAlerts=0 继承时段默认；>0 覆盖", () => {
  const db = openDB(undefined, ":memory:");
  try {
    const stockRes = db.prepare(`INSERT INTO stocks(symbol) VALUES('AAPL')`).run();
    const stockID = Number(stockRes.lastInsertRowid);
    db.prepare(`INSERT INTO levels(stock_id,side,target,enabled,max_alerts,uid) VALUES(?,?,?,1,0,lower(hex(randomblob(16))))`).run(stockID, "buy", "100");
    db.prepare(`INSERT INTO levels(stock_id,side,target,enabled,max_alerts,uid) VALUES(?,?,?,1,7,lower(hex(randomblob(16))))`).run(stockID, "sell", "200");
    db.prepare(`INSERT INTO query_windows(start,end,interval,max_alerts,enabled) VALUES(?,?,?, ?,1)`).run(WIN.start, WIN.end, WIN.interval, WIN.max_alerts);
    const w = queryWindows(db)[0];
    const levels = listLevels(db, stockID);
    const buy = levels.find((l) => l.Side === "buy")!;
    const sell = levels.find((l) => l.Side === "sell")!;
    assert.equal(buy.MaxAlerts > 0 ? buy.MaxAlerts : w.max_alerts, 3);
    assert.equal(sell.MaxAlerts > 0 ? sell.MaxAlerts : w.max_alerts, 7);
  } finally {
    db.close();
  }
});

test("windowSummary：全部启用档位耗尽 → capped（停止本时段该股票）", () => {
  const levels = [
    { ID: 1, Enabled: true, Used: 3, Limit: 3 },
    { ID: 2, Enabled: true, Used: 1, Limit: 2 },
  ] as never[];
  let summary = windowSummary(levels, WIN);
  assert.ok(!summary.capped);
  assert.match(summary.status, /1\/2 个已用尽/);
  const exhausted = [
    { ID: 1, Enabled: true, Used: 3, Limit: 3 },
    { ID: 2, Enabled: true, Used: 2, Limit: 2 },
  ] as never[];
  summary = windowSummary(exhausted, WIN);
  assert.ok(summary.capped);
  assert.match(summary.status, /本时段自动查询已停止/);
  // 暂停的时段不置 capped，但显示暂停
  summary = windowSummary(levels, { ...WIN, enabled: false });
  assert.ok(!summary.capped);
  assert.match(summary.status, /时段查询已暂停/);
});

test("额度计数：notifications 按档位 uid 统计（windowStatus 集成）", () => {
  const db = openDB(undefined, ":memory:");
  try {
    const stockRes = db.prepare(`INSERT INTO stocks(symbol) VALUES('AAPL')`).run();
    const stockID = Number(stockRes.lastInsertRowid);
    const levelRes = db.prepare(`INSERT INTO levels(stock_id,side,target,enabled,max_alerts,uid) VALUES(?,?,?,1,0,'uid-a')`).run(stockID, "buy", "100");
    const levelID = Number(levelRes.lastInsertRowid);
    db.prepare(`INSERT INTO query_windows(start,end,interval,max_alerts,enabled) VALUES(22*60, 2*60, 5, 3, 1)`).run();
    const w = queryWindows(db)[0];
    const runRes = db.prepare(`INSERT INTO runs(kind,started_at,status) VALUES('manual',?,'completed')`).run(rfc3339Nano(new Date()));
    const runID = Number(runRes.lastInsertRowid);
    const record = (status: string): void => {
      db.prepare(`INSERT INTO notifications(run_id,symbol,price,quote_at,levels,status,created_at,window_id,window_day) VALUES(?,?,?,?,?,?,?,?,'2026-03-09')`)
        .run(runID, "AAPL", "99", rfc3339Nano(new Date()), JSON.stringify([{ id: levelID, uid: "uid-a" }]), status, rfc3339Nano(new Date()), w.id);
    };
    record("成功");
    record("部分成功");
    record("失败"); // 不占
    record("命中但未通知（无启用渠道）"); // 不占
    const { status, capped } = windowStatus(db, stockID, "AAPL", atNY("2026-03-09T23:00"), "America/New_York");
    assert.ok(!capped);
    // 已占 2 次（< 上限 3）：档位未耗尽
    assert.match(status, /0\/1 个已用尽/);
    record("不确定"); // 3 次：恰好达到上限 → 已用尽
    const third = windowStatus(db, stockID, "AAPL", atNY("2026-03-09T23:00"), "America/New_York");
    assert.ok(third.capped, "Used=3 达到上限 3 即耗尽");
    record("发送中"); // 发送中也占（此后不再触发新查询）
    const after = windowStatus(db, stockID, "AAPL", atNY("2026-03-09T23:00"), "America/New_York");
    assert.ok(after.capped);
    assert.match(after.status, /本时段自动查询已停止/);
  } finally {
    db.close();
  }
});

test("nextFire：DST 不存在的墙钟被跳过（America/New_York 2026 春令时 03:02）", () => {
  // 2026-03-08 02:00→03:00 前拨：02:30 不存在。
  const after = atNY("2026-03-08T01:00");
  const t = nextFireForSchedule(2, 30, "America/New_York", after);
  assert.ok(t);
  // 应落到 3 月 9 日（3 月 8 日 02:30 不存在）。
  assert.equal(t.toISOString().slice(0, 10), new Date(Date.UTC(2026, 2, 9)).toISOString().slice(0, 10) ? "2026-03-09" : t.toISOString().slice(0, 10));
});

test("nextWindowOccurrence：下一次对齐触发点", () => {
  const after = atNY("2026-03-09T23:07");
  const t = nextWindowOccurrence(WIN, "America/New_York", after)!;
  assert.ok(t);
  const occ = occurrence(WIN, t, "America/New_York");
  assert.ok(occ.active);
  assert.equal(occ.offset % 5, 0);
  assert.ok(t.getTime() > after.getTime());
  assert.ok(t.getTime() - after.getTime() <= 5 * 60 * 1000);
});

test("parseClock 严格 HH:MM", () => {
  assert.equal(parseClock("09:30"), 570);
  assert.equal(parseClock("9:30"), null);
  assert.equal(parseClock("09:5"), null);
  assert.equal(parseClock("24:00"), null);
});

test("windowDuration：跨午夜 240 分钟", () => {
  assert.equal(windowDuration(WIN), 240);
});
