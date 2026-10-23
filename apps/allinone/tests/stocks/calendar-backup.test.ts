// 日历与备份测试：2026–2028 表与 go-marketcal 锁定版本输出一致；备份导出/导入往返。
import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarForYear, isTradingDayKey, isOpen, regularHours, calendarReviewed, EARLY_CLOSE_MIN } from "../../src/modules/stocks/calendar.ts";
import { openDB, queryWindows, schedules, getDB } from "../../src/modules/stocks/store.ts";
import { exportConfig, validateConfig, importConfig } from "../../src/modules/stocks/backup.ts";
import { checkBarkURL, checkFeishuWebhook, checkProxy, checkTG, channelStatus, enabledChannels } from "../../src/modules/stocks/notify.ts";

test("2026 假日与提前收市（与 go-marketcal 锁定版本逐项一致）", () => {
  const y2026 = calendarForYear(2026)!;
  assert.deepEqual(Object.keys(y2026.holidays).sort(), [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  ]);
  assert.deepEqual(Object.keys(y2026.earlyCloses).sort(), ["2026-11-27", "2026-12-24"]);
});

test("2027/2028 假日与提前收市", () => {
  const y2027 = calendarForYear(2027)!;
  assert.ok(y2027.holidays["2027-01-01"]);
  assert.ok(y2027.holidays["2027-12-24"]); // 圣诞在周日，周一补休
  assert.deepEqual(Object.keys(y2027.earlyCloses), ["2027-11-26"]);
  const y2028 = calendarForYear(2028)!;
  assert.ok(!y2028.holidays["2028-01-01"]); // 1/1 周六：不补休、跨年不闭市
  assert.ok(y2028.holidays["2028-07-04"]);
  assert.deepEqual(Object.keys(y2028.earlyCloses).sort(), ["2028-07-03", "2028-11-24"]);
});

test("周末不交易；2026-01-02（周五）常规时段开市", () => {
  assert.ok(!isTradingDayKey("2026-01-03"));
  assert.ok(!isTradingDayKey("2026-01-04"));
  assert.ok(isTradingDayKey("2026-01-02"));
});

test("提前收市日 13:00 收市（美东）", () => {
  const hours = regularHours("2026-11-27")!;
  assert.equal(hours.close.getTime() - hours.open.getTime(), (EARLY_CLOSE_MIN - 9 * 60 - 30) * 60 * 1000);
  // 13:30 ET = 18:30Z（11 月为 EST，UTC-5）应已收市
  const t = new Date("2026-11-27T18:30:00Z");
  assert.ok(!isOpen(t));
  // 12:59 ET 仍开市
  assert.ok(isOpen(new Date("2026-11-27T17:59:00Z")));
});

test("calendarReviewed：2026–2028 内 true，2025/2029 false", () => {
  assert.ok(calendarReviewed(new Date("2026-06-15T14:00:00Z")));
  assert.ok(calendarReviewed(new Date("2028-12-30T14:00:00Z")));
  assert.ok(!calendarReviewed(new Date("2025-06-15T14:00:00Z")));
  assert.ok(!calendarReviewed(new Date("2029-01-01T14:00:00Z")));
});

test("通知配置校验：Bark/飞书/Telegram/代理", () => {
  assert.equal(checkBarkURL("https://api.day.app/", false), "https://api.day.app");
  assert.throws(() => checkBarkURL("http://192.168.1.2/", false), /内网/);
  assert.equal(checkBarkURL("http://192.168.1.2/", true), "http://192.168.1.2");
  assert.throws(() => checkBarkURL("https://evil.example.com/push", false), /Bark/);
  const hook = checkFeishuWebhook("https://open.feishu.cn/open-apis/bot/v2/hook/abcd1234");
  assert.equal(hook, "https://open.feishu.cn/open-apis/bot/v2/hook/abcd1234");
  assert.throws(() => checkFeishuWebhook("https://evil.cn/open-apis/bot/v2/hook/abcd1234"), /飞书/);
  checkTG("123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "-1001234567890");
  assert.throws(() => checkTG("bad token", "123"), /Telegram/);
  assert.equal(checkProxy("192.168.5.1:7890"), "http://192.168.5.1:7890");
  assert.equal(checkProxy("socks5://192.168.5.1:7891"), "socks5://192.168.5.1:7891");
  assert.throws(() => checkProxy("http://user:pass@1.2.3.4:8080"), /代理/);
});

test("channelStatus：成功/部分成功/不确定/失败", () => {
  assert.equal(channelStatus([{ Name: "Bark", Status: "成功", Error: "" }, { Name: "飞书", Status: "成功", Error: "" }]), "成功");
  assert.equal(channelStatus([{ Name: "Bark", Status: "成功", Error: "" }, { Name: "飞书", Status: "失败", Error: "x" }]), "部分成功");
  assert.equal(channelStatus([{ Name: "Bark", Status: "不确定", Error: "x" }, { Name: "飞书", Status: "失败", Error: "x" }]), "不确定");
  assert.equal(channelStatus([{ Name: "Bark", Status: "失败", Error: "x" }, { Name: "飞书", Status: "失败", Error: "x" }]), "失败");
});

test("enabledChannels：启用且配置完整才纳入", () => {
  const c = {
    Bark: { URL: "https://api.day.app", Key: "k", Local: false },
    BarkEnabled: true,
    FeishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abcd1234",
    FeishuSecret: "",
    FeishuEnabled: true,
    TGToken: "",
    TGChatID: "",
    TGEnabled: true,
    Proxy: "",
    BarkProxy: false,
    FeishuProxy: false,
    TGProxy: false,
  };
  assert.deepEqual(enabledChannels(c), ["Bark", "飞书"]);
});

test("配置备份导出/导入往返（v5）", () => {
  const db = openDB(undefined, ":memory:");
  try {
    db.prepare(`INSERT INTO stocks(symbol,note,enabled,reference_buy) VALUES('AAPL','苹果',1,'')`).run();
    const stockID = Number((db.prepare(`SELECT id FROM stocks WHERE symbol='AAPL'`).get() as { id: number }).id);
    db.prepare(`INSERT INTO levels(stock_id,side,target,note,max_alerts,uid) VALUES(?,?,?, '尝试减仓',0, lower(hex(randomblob(16))))`).run(stockID, "sell", "200.5");
    db.prepare(`INSERT INTO schedules(hour,minute,enabled) VALUES(21,30,1)`).run();
    db.prepare(`INSERT INTO query_windows(start,end,interval,max_alerts,enabled) VALUES(1320, 120, 5, 3, 1)`).run();
    const backup = exportConfig(db);
    assert.equal(backup.format, "TickerSentry");
    assert.equal(backup.version, 5);
    assert.equal(backup.stocks.length, 1);
    assert.equal(backup.stocks[0].levels.length, 1);
    assert.equal(backup.schedules.length, 1);
    assert.equal(backup.windows.length, 1);
    validateConfig(backup);
    // 导入到新库
    const db2 = openDB(undefined, ":memory:");
    try {
      importConfig(db2, JSON.parse(JSON.stringify(backup)) as typeof backup, "", "");
      assert.equal((db2.prepare(`SELECT count(*) AS c FROM stocks`).get() as { c: number }).c, 1);
      assert.equal((db2.prepare(`SELECT count(*) AS c FROM levels`).get() as { c: number }).c, 1);
      assert.equal((db2.prepare(`SELECT note FROM levels LIMIT 1`).get() as { note: string }).note, "尝试减仓");
      assert.equal((db2.prepare(`SELECT max_alerts FROM query_windows LIMIT 1`).get() as { max_alerts: number }).max_alerts, 3);
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }
});

test("配置备份导入校验：非法版本/重叠时段/坏目标价被拒绝", () => {
  const base = {
    format: "TickerSentry",
    version: 5,
    created_at: "2026-01-01T00:00:00Z",
    settings: {
      api_key: "", bark_url: "", bark_key: "", bark_local: false, bark_enabled: false,
      feishu_webhook: "", feishu_secret: "", feishu_enabled: false,
      tg_token: "", tg_chat_id: "", tg_enabled: false,
      timezone: "Asia/Shanghai", default_alerts: 3, proxy_url: "",
      bark_proxy: false, feishu_proxy: false, tg_proxy: false,
    },
    stocks: [],
    schedules: [],
    windows: [],
  };
  validateConfig(structuredClone(base));
  assert.throws(() => validateConfig({ ...structuredClone(base), version: 8 } as never), /版本/);
  assert.throws(() => validateConfig({ ...structuredClone(base), version: 0 } as never), /版本/);
  const badWindow = {
    ...structuredClone(base),
    windows: [
      { id: 1, start: 0, end: 600, interval: 5, max_alerts: 3, enabled: true },
      { id: 2, start: 300, end: 700, interval: 5, max_alerts: 3, enabled: true },
    ],
  };
  assert.throws(() => validateConfig(badWindow as never), /重叠/);
  const badTarget = {
    ...structuredClone(base),
    stocks: [{ symbol: "AAPL", note: "", reference_buy: "", enabled: true, levels: [{ side: "buy", target: "1e5", note: "", mode: "once", cooldown: 60, max_alerts: 0, enabled: true, alerted: false, last_attempt: "" }] }],
  };
  assert.throws(() => validateConfig(badTarget as never), /目标价/);
});

test("getDB 在未初始化时延迟打开（模块单例语义）", () => {
  // 仅验证导出存在且不抛错（实际打开依赖 dataDir，单测中不触发）。
  assert.ok(typeof getDB === "function");
  assert.ok(schedules !== undefined);
  assert.ok(queryWindows !== undefined);
});
