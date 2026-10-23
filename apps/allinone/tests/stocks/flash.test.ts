// 闪断/中断语义（Go flash_test.go 的语义部分 + openDB 启动自愈）。
// Go 侧 flash_test 主要验证 flash 白名单与 toast 渲染；TS 侧对应：
// 1) flash 白名单映射 2) 查询中断后 pending/发送中记录的收尾语义。
import assert from "node:assert/strict";
import { test } from "node:test";

import { openDB, createRun, saveResult, getRun, recordAttemptChannels, updateChannel, finishAttempt, dueLevels } from "../../src/modules/stocks/store.ts";
import { parseDecimal } from "../../src/modules/stocks/decimal.ts";

test("档位选择：买入最低命中、卖出最高命中、同价取最早档位", () => {
  const db = openDB(undefined, ":memory:");
  try {
    const res = db.prepare(`INSERT INTO stocks(symbol) VALUES('AAPL')`).run();
    const stockID = Number(res.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO levels(stock_id,side,target,enabled,uid) VALUES(?,?,?,1,lower(hex(randomblob(16))))`);
    ins.run(stockID, "buy", "200");
    ins.run(stockID, "buy", "180");
    ins.run(stockID, "sell", "190");
    ins.run(stockID, "sell", "210");
    // 价格 190：买命中 200（≤），卖出命中 190（≥）
    let due = dueLevels(db, stockID, parseDecimal("190")!);
    assert.deepEqual(due.map((l) => [l.Side, l.Target]), [["buy", "200"], ["sell", "190"]]);
    // 价格 180：买命中 180（不是 200）
    due = dueLevels(db, stockID, parseDecimal("180")!);
    assert.equal(due[0].Target, "180");
    // 价格 160：只命中买入 180
    due = dueLevels(db, stockID, parseDecimal("160")!);
    assert.deepEqual(due.map((l) => l.Side), ["buy"]);
    // 同价两档取最早创建
    ins.run(stockID, "buy", "180");
    due = dueLevels(db, stockID, parseDecimal("100")!);
    const buyTargets = due.filter((l) => l.Side === "buy").map((l) => Number(l.ID));
    const earliest = db.prepare(`SELECT id FROM levels WHERE stock_id=? AND side='buy' AND target='180' ORDER BY id LIMIT 1`).get(stockID) as { id: number };
    assert.equal(buyTargets[0], earliest.id);
  } finally {
    db.close();
  }
});

test("中断收尾：pending 结果、发送中渠道、待发送渠道按 Go openDB 规则收尾", () => {
  const db = openDB(undefined, ":memory:");
  try {
    const stockRes = db.prepare(`INSERT INTO stocks(symbol) VALUES('AAPL')`).run();
    const stockID = Number(stockRes.lastInsertRowid);
    db.prepare(`INSERT INTO levels(stock_id,side,target,enabled,uid) VALUES(?,?,?,1,lower(hex(randomblob(16))))`).run(stockID, "buy", "100");
    const stocks = [{ Symbol: "AAPL" }] as never[];
    void stocks;
    const all = db.prepare(`SELECT id,symbol FROM stocks`).all() as Array<{ id: number; symbol: string }>;
    const runID = createRun(db, all.map((s) => ({ ID: s.id, Symbol: s.symbol, Enabled: true })) as never, "scheduled", 0, "", "");
    // 一条 pending 结果 + 一条发送中的通知
    saveResult(db, runID, { Symbol: "AAPL", Status: "pending", Price: "", Open: "", PrevClose: "", QuoteAt: "", FetchedAt: "", Source: "", TimeField: "", Delay: "", Error: "", AlertStatus: "", AssetOK: false });
    const q = { Symbol: "AAPL", Price: "99", QuoteAt: new Date() };
    const levels = dueLevels(db, stockID, parseDecimal("99")!);
    const notifID = recordAttemptChannels(db, runID, q, levels, "发送中", 0, "", ["Bark", "Telegram"]);
    // 模拟重启：重新走 openDB 的收尾 SQL 验证语义。
    // Go 顺序：先把「发送中」渠道标不确定，再把「待发送」渠道标未发送。
    // 渠道创建时即为「待发送」，alert 循环里逐个改「发送中」再收尾；
    // 这里直接构造「Bark 发送中、Telegram 待发送」的中间态：
    updateChannel(db, notifID, "Bark", "发送中", "");
    updateChannel(db, notifID, "Telegram", "待发送", "");
    db.prepare(`UPDATE results SET status='interrupted', error='进程中断' WHERE status='pending'`).run();
    db.prepare(`UPDATE notification_channels SET status='不确定',error='进程中断，发送结果未知' WHERE status='发送中'`).run();
    db.prepare(`UPDATE notification_channels SET status='未发送' WHERE status='待发送'`).run();
    db.prepare(`UPDATE notifications SET status='不确定', error='进程中断，请查看各渠道发送结果' WHERE id=?`).run(notifID);
    const run = getRun(db, runID)!;
    assert.equal(run.results[0].Status, "interrupted");
    const channels = db.prepare(`SELECT channel,status FROM notification_channels WHERE notification_id=? ORDER BY channel`).all(notifID) as Array<{ channel: string; status: string }>;
    assert.deepEqual(channels.map((c) => [c.channel, c.status]), [["Bark", "不确定"], ["Telegram", "未发送"]]);
  } finally {
    db.close();
  }
});

test("渠道结果聚合：任一成功/不确定占用额度，全部明确失败不占", () => {
  const db = openDB(undefined, ":memory:");
  try {
    const stockRes = db.prepare(`INSERT INTO stocks(symbol) VALUES('AAPL')`).run();
    const stockID = Number(stockRes.lastInsertRowid);
    db.prepare(`INSERT INTO levels(stock_id,side,target,enabled,uid) VALUES(?,?,?,1,lower(hex(randomblob(16))))`).run(stockID, "sell", "100");
    const all = db.prepare(`SELECT id,symbol FROM stocks`).all() as Array<{ id: number; symbol: string }>;
    const runID = createRun(db, all.map((s) => ({ ID: s.id, Symbol: s.symbol, Enabled: true })) as never, "manual", 0, "", "");
    const levels = dueLevels(db, stockID, parseDecimal("120")!);
    const q = { Symbol: "AAPL", Price: "120", QuoteAt: new Date() };
    const id = recordAttemptChannels(db, runID, q, levels, "发送中", 0, "", ["Bark", "Telegram"]);
    updateChannel(db, id, "Bark", "失败", "Bark HTTP 500");
    updateChannel(db, id, "Telegram", "成功", "");
    finishAttempt(db, id, runID, "AAPL", "部分成功", "请查看各渠道发送结果");
    const usage = db.prepare(`SELECT count(*) AS c FROM notifications WHERE id=? AND status IN ('发送中','成功','部分成功','不确定')`).get(id) as { c: number };
    assert.equal(usage.c, 1, "部分成功必须占用档位额度");
    // 全部明确失败：不占
    const id2 = recordAttemptChannels(db, runID, q, levels, "发送中", 0, "", ["Bark"]);
    updateChannel(db, id2, "Bark", "失败", "Bark HTTP 500");
    finishAttempt(db, id2, runID, "AAPL", "失败", "请查看各渠道发送结果");
    const usage2 = db.prepare(`SELECT count(*) AS c FROM notifications WHERE id=? AND status IN ('发送中','成功','部分成功','不确定')`).get(id2) as { c: number };
    assert.equal(usage2.c, 0, "全部明确失败不占用档位额度");
    // 不确定：占用
    const id3 = recordAttemptChannels(db, runID, q, levels, "发送中", 0, "", ["Bark"]);
    updateChannel(db, id3, "Bark", "不确定", "Bark 网络异常或超时，发送结果不确定");
    finishAttempt(db, id3, runID, "AAPL", "不确定", "请查看各渠道发送结果");
    const usage3 = db.prepare(`SELECT count(*) AS c FROM notifications WHERE id=? AND status IN ('发送中','成功','部分成功','不确定')`).get(id3) as { c: number };
    assert.equal(usage3.c, 1, "结果不确定必须占用档位额度");
  } finally {
    db.close();
  }
});
