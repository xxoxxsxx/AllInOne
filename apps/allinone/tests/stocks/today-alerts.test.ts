import assert from "node:assert/strict";
import { test } from "node:test";
import { openDB, todayAlertSummary } from "../../src/modules/stocks/store.ts";

test("今日总览按本地日统计所有记录，区分发送中和成功并保留历史档位", () => {
  const db = openDB(undefined, ":memory:");
  try {
    db.exec("INSERT INTO runs(id,kind,status,started_at) VALUES(1,'manual','completed','2026-01-01T00:00:00Z')");
    const insert = db.prepare("INSERT INTO notifications(run_id,symbol,price,quote_at,levels,status,created_at) VALUES(1,'MU','490','',?,?,?)");
    const levels = JSON.stringify([{side:'review',target:'500'}, {side:'sell',target:'450'}]);
    insert.run(levels, '成功', '2026-01-01T15:59:59Z');
    insert.run(levels, '成功', '2026-01-01T16:00:00Z');
    insert.run(levels, '部分成功', '2026-01-01T17:00:00Z');
    insert.run(levels, '发送中', '2026-01-01T18:00:00Z');
    insert.run(levels, '命中但未通知（无启用渠道）', '2026-01-01T19:00:00Z');
    insert.run('null', '不确定', '2026-01-01T20:00:00Z');
    insert.run(levels, '成功', '2026-01-02T16:00:00Z');
    const [s] = todayAlertSummary(db, new Date('2026-01-02T04:00:00Z'), 'Asia/Shanghai');
    assert.equal(s.Notifications, 5);
    assert.equal(s.Delivered, 2);
    assert.equal(s.Pending, 1);
    assert.equal(s.Unnotified, 1);
    assert.equal(s.Failed, 1);
    assert.equal(s.Review.length, 1);
    assert.equal(s.Sell.length, 1);
    assert.equal(s.Buy.length, 0);
    assert.deepEqual(todayAlertSummary(db, new Date('2026-02-01T04:00:00Z'), 'Asia/Shanghai'), []);
  } finally { db.close(); }
});
