import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import Database from "better-sqlite3";
import { alert } from "../../src/modules/stocks/run.ts";
import { createRun, getStock, openDB } from "../../src/modules/stocks/store.ts";
import { parseDecimal } from "../../src/modules/stocks/decimal.ts";
import { getChannelConfig, getChannelsDb } from "../../src/lib/channels/center.ts";
import { getModulePolicy, saveModulePolicy } from "../../src/lib/channels/module-policy.ts";
import type { Quote } from "../../src/modules/stocks/quote.ts";

// Exercise the real alert path against an isolated channel DB and local Bark server.
test("股票策略实时生效：默认关闭不占额度，模块选择与全局开关取交集", async () => {
  let sends = 0;
  const server = http.createServer((_req, res) => {
    sends++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: 200, message: "success" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const db = openDB(undefined, ":memory:");
  const previousChannels = globalThis.__channelsSqlite;
  const channels = new Database(":memory:");
  // Bootstrap the same schema used by the channel center without touching DATA_DIR.
  channels.exec(`CREATE TABLE channels (
    id INTEGER PRIMARY KEY, bark_url TEXT DEFAULT '', bark_key TEXT DEFAULT '', bark_local INTEGER DEFAULT 0,
    bark_enabled INTEGER DEFAULT 0, feishu_webhook TEXT DEFAULT '', feishu_secret TEXT DEFAULT '', feishu_enabled INTEGER DEFAULT 0,
    tg_token TEXT DEFAULT '', tg_chat_id TEXT DEFAULT '', tg_enabled INTEGER DEFAULT 0, proxy_url TEXT DEFAULT '',
    bark_proxy INTEGER DEFAULT 0, feishu_proxy INTEGER DEFAULT 0, tg_proxy INTEGER DEFAULT 0, updated_at TEXT DEFAULT ''
  ); INSERT INTO channels(id) VALUES(1)`);
  globalThis.__channelsSqlite = channels;
  try {
    const port = (server.address() as { port: number }).port;
    getChannelsDb().prepare("UPDATE channels SET bark_url=?,bark_key='test',bark_local=1,bark_enabled=1 WHERE id=1").run(`http://127.0.0.1:${port}`);
    const originalConfig = getChannelConfig();
    const stockID = Number(db.prepare("INSERT INTO stocks(symbol) VALUES('AAPL')").run().lastInsertRowid);
    db.prepare("INSERT INTO levels(stock_id,side,target,enabled,uid) VALUES(?,'buy','100',1,'policy-level')").run(stockID);
    const stock = getStock(db, stockID)!;
    const runID = createRun(db, [stock], "manual", 0, "", "");
    const fetched = new Date("2026-01-02T19:00:00Z");
    const quote: Quote = { Symbol: "AAPL", Price: parseDecimal("99")!, At: fetched, Open: "", PrevClose: "", Source: "test", TimeField: "last_update_at", Delay: "", AssetOK: true };
    const fire = () => alert(db, runID, stock, quote, fetched, "America/New_York");
    const notificationCount = () => (db.prepare("SELECT count(*) AS n FROM notifications").get() as { n: number }).n;
    assert.deepEqual(getModulePolicy(db, "stocks", false), { enabled: false, bark: true, feishu: true, telegram: true });
    assert.equal(await fire(), "股票自动推送已关闭");
    assert.equal(sends, 0);
    assert.equal(notificationCount(), 0, "关闭不创建发送中记录，因此不会占用提醒额度");

    saveModulePolicy(db, "stocks", { enabled: true, bark: false, feishu: false, telegram: false });
    assert.equal(await fire(), "命中但未通知（无启用渠道）");
    assert.equal(sends, 0, "全局开启但本模块未勾选，不发送");
    assert.deepEqual(getChannelConfig(), originalConfig, "模块策略不能修改全局渠道");

    saveModulePolicy(db, "stocks", { enabled: true, bark: true, feishu: false, telegram: false });
    channels.prepare("UPDATE channels SET bark_enabled=0 WHERE id=1").run();
    assert.equal(await fire(), "命中但未通知（无启用渠道）");
    assert.equal(sends, 0, "模块勾选不能覆盖全局关闭");
    channels.prepare("UPDATE channels SET bark_enabled=1 WHERE id=1").run();
    assert.equal(await fire(), "成功");
    assert.equal(sends, 1, "保存后不重启即可发送");
    assert.deepEqual(db.prepare("SELECT channel FROM notification_channels").all(), [{ channel: "Bark" }]);

    const countBeforeDisable = notificationCount();
    saveModulePolicy(db, "stocks", { enabled: false, bark: true, feishu: true, telegram: true });
    assert.equal(await fire(), "股票自动推送已关闭");
    assert.equal(sends, 1);
    assert.equal(notificationCount(), countBeforeDisable, "重新关闭不新增发送记录或额度");
  } finally {
    globalThis.__channelsSqlite = previousChannels;
    channels.close();
    db.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
