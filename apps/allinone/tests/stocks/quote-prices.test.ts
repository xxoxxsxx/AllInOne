// quote_prices_test 翻译：报价年龄/选档断言（Go quote_prices_test.go + alertValidity）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { alertValidityLocal, parseOptionalPrice } from "../../src/modules/stocks/quote.ts";
import { openDB, createRun, saveResult, listStocks, listStockQuotes, getRun } from "../../src/modules/stocks/store.ts";
import { parseRFC3339 } from "../../src/modules/stocks/tz.ts";

// —— 可选价格字段解析（Go TestOpeningPriceParsing 的字段语义）——
test("open/previous_close 可选字段：非法/非正数不保留", () => {
  assert.equal(parseOptionalPrice("101.2300"), "101.23");
  assert.equal(parseOptionalPrice(""), "");
  assert.equal(parseOptionalPrice("invalid"), "");
  assert.equal(parseOptionalPrice("0"), "");
  assert.equal(parseOptionalPrice("-1"), "");
});

// —— 报价年龄与有效性（alertValidity 全分支）——
function quoteAt(iso: string, assetOK = true, field = "last_update_at") {
  return { At: parseRFC3339(iso)!, TimeField: field, AssetOK: assetOK };
}

// 用受控日期绕开「真实当前时间必须处于常规时段」的限制：
// 2026-01-02 是周五，14:00 ET 处于常规时段且在核验窗口内。
const FETCHED_ET = "2026-01-02T19:00:00Z"; // 14:00 America/New_York

test("报价年龄 -2～30 分钟边界", () => {
  const base = parseRFC3339(FETCHED_ET)!;
  const mk = (ms: number): Date => new Date(base.getTime() + ms);
  // 年龄 0：有效
  assert.equal(alertValidityLocal(quoteAt(FETCHED_ET), base), "");
  // 年龄 30 分钟：有效（右边界含）
  assert.equal(alertValidityLocal(quoteAt(mk(-30 * 60 * 1000).toISOString()), base), "");
  // 年龄 30 分钟 + 1ms：过期
  assert.equal(
    alertValidityLocal(quoteAt(new Date(base.getTime() - 30 * 60 * 1000 - 1).toISOString()), base),
    "行情过期或时间异常，未触价",
  );
  // 未来 2 分钟：有效（时钟偏差容忍）
  assert.equal(alertValidityLocal(quoteAt(mk(2 * 60 * 1000).toISOString()), base), "");
  // 未来 2 分钟 + 1ms：异常
  assert.equal(
    alertValidityLocal(quoteAt(new Date(base.getTime() + 2 * 60 * 1000 + 1).toISOString()), base),
    "行情过期或时间异常，未触价",
  );
});

test("休市/日历外/时间字段/资产资格逐项拒绝", () => {
  const base = parseRFC3339(FETCHED_ET)!;
  // 周六（2026-01-03）
  const saturday = "2026-01-03T19:00:00Z";
  assert.equal(alertValidityLocal(quoteAt(saturday), parseRFC3339(saturday)!), "市场休市，未触价");
  // 2025 年：超出核验窗口
  const outOfWindow = "2025-01-02T19:00:00Z";
  assert.equal(alertValidityLocal(quoteAt(outOfWindow), parseRFC3339(outOfWindow)!), "交易日历超出已核验年份，未触价");
  // 提前收市后 14:00 ET（2026-11-27，13:00 收市）
  const afterEarly = "2026-11-27T19:00:00Z";
  assert.equal(alertValidityLocal(quoteAt(afterEarly), parseRFC3339(afterEarly)!), "市场休市，未触价");
  // 时间字段缺失
  assert.equal(
    alertValidityLocal(quoteAt(FETCHED_ET, true, "timestamp"), base),
    "缺少可用的行情时间字段，未触价",
  );
  // 资产未核验
  assert.equal(
    alertValidityLocal(quoteAt(FETCHED_ET, false), base),
    "资产类型或交易所未核验，未执行价格提醒判断",
  );
  // 报价时间不属于当日常规时段（当天 20:30 ET 之后）
  assert.equal(
    alertValidityLocal(quoteAt("2026-01-02T01:30:00Z"), base),
    "报价不属于当日常规时段，未触价",
  );
});

// —— 持久化与视图（Go TestPricePersistenceAndViews 的存储层部分）——
test("价格持久化：open/prev_close 不被后续缺失字段继承", () => {
  const db = openDB("/tmp/tsdb-price-test-" + process.pid, "ticker.db");
  try {
    db.prepare(`DELETE FROM results`).run();
    db.prepare(`DELETE FROM runs`).run();
    db.prepare(`INSERT INTO stocks(symbol) VALUES('AAPL')`).run();
    const stocks0 = listStocks(db);
    const id = createRun(db, stocks0, "manual", 0, "", "");
    saveResult(db, id, { Symbol: "AAPL", Price: "103", Open: "101.23", PrevClose: "100", Status: "ok", QuoteAt: "", FetchedAt: "", Source: "", TimeField: "", Delay: "", Error: "", AlertStatus: "", AssetOK: false });
    const stocks = listStocks(db);
    assert.equal(stocks.length, 1);
    assert.equal(stocks[0].Open, "101.23");
    assert.equal(stocks[0].PrevClose, "100");
    const quotes = listStockQuotes(db, "AAPL");
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].Open, "101.23");
    const run = getRun(db, id)!;
    assert.equal(run.results[0].Open, "101.23");
    assert.equal(run.results[0].PrevClose, "100");
    // 后一条缺失可选字段：不得继承昨天的 open
    const id2 = createRun(db, stocks0, "manual", 0, "", "");
    saveResult(db, id2, { Symbol: "AAPL", Price: "104", Status: "ok", Open: "", PrevClose: "", QuoteAt: "", FetchedAt: "", Source: "", TimeField: "", Delay: "", Error: "", AlertStatus: "", AssetOK: false });
    const stocks2 = listStocks(db);
    assert.equal(stocks2[0].Open, "");
    assert.equal(stocks2[0].PrevClose, "");
  } finally {
    db.close();
  }
});

// fetchQuote 的网络路径不进单测（依赖外部服务）；解析分支的受控校验
// 由 parseOptionalPrice / alertValidityLocal 用例覆盖。
