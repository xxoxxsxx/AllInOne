// Finnhub 行情源：解析分支（parseFinnhubQuote）、时间字段闸门（TimeField "t"）、
// provider 归一化与 store 双源读写。网络路径不进单测（与 quote-prices.test 同规则）。
import test from "node:test";
import assert from "node:assert/strict";

import { alertValidityLocal, normalizeQuoteProvider, parseFinnhubQuote, QUOTE_PROVIDERS, type QuoteProvider } from "../../src/modules/stocks/quote.ts";
import { decString } from "../../src/modules/stocks/decimal.ts";
import { openDB, quoteSourceOf, saveQuoteSource } from "../../src/modules/stocks/store.ts";

// 受控基准：2026-01-02（周五）14:00 ET 常规时段。
const FETCHED = new Date("2026-01-02T19:00:00Z");
const NOW = FETCHED;

const GOOD = { c: 187.5, d: -2.25, dp: -1.19, h: 190, l: 186, o: 189.75, pc: 189.75, t: Math.floor(FETCHED.getTime() / 1000) };

test("parseFinnhubQuote：完整响应逐字段映射", () => {
  const q = parseFinnhubQuote(GOOD, "AAPL", NOW);
  assert.equal(q.Symbol, "AAPL");
  assert.equal(decString(q.Price), "187.5");
  assert.equal(q.Open, "189.75");
  assert.equal(q.PrevClose, "189.75");
  assert.equal(q.At.getTime(), GOOD.t * 1000);
  assert.equal(q.TimeField, "t");
  assert.equal(q.Source, "Finnhub");
  assert.equal(q.AssetOK, true, "Finnhub 免费档仅美股，交易所/类型闸门按源放宽");
});

test("parseFinnhubQuote：o/pc 缺失或非法时留空，不继承", () => {
  const q = parseFinnhubQuote({ c: 100, t: Math.floor(NOW.getTime() / 1000) }, "AAPL", NOW);
  assert.equal(q.Open, "");
  assert.equal(q.PrevClose, "");
  const bad = parseFinnhubQuote({ c: 100, o: -5, pc: 0, t: Math.floor(NOW.getTime() / 1000) }, "AAPL", NOW);
  assert.equal(bad.Open, "");
  assert.equal(bad.PrevClose, "");
});

test("parseFinnhubQuote：价格异常与时间异常逐项拒绝", () => {
  const t = Math.floor(NOW.getTime() / 1000);
  assert.throws(() => parseFinnhubQuote({ t }, "AAPL", NOW), /行情缺少价格/);
  assert.throws(() => parseFinnhubQuote({ c: 0, t }, "AAPL", NOW), /行情价格无效/);
  assert.throws(() => parseFinnhubQuote({ c: -3, t }, "AAPL", NOW), /行情价格无效/);
  assert.throws(() => parseFinnhubQuote({ c: 100 }, "AAPL", NOW), /行情缺少可信更新时间/);
  assert.throws(() => parseFinnhubQuote({ c: 100, t: 1.5 }, "AAPL", NOW), /行情缺少可信更新时间/);
  assert.throws(() => parseFinnhubQuote({ c: 100, t: 1 }, "AAPL", NOW), /行情更新时间无效/);
  assert.throws(() => parseFinnhubQuote({ c: 100, t: Math.floor(NOW.getTime() / 1000) + 300 }, "AAPL", NOW), /行情更新时间在未来/);
});

test("alertValidity 放行 Finnhub 时间字段 t，且走完整新鲜度/时段门禁", () => {
  const fresh = parseFinnhubQuote(GOOD, "AAPL", FETCHED);
  assert.equal(alertValidityLocal(fresh, FETCHED), "");
  // 停机超 30 分钟的报价过期
  const stale = parseFinnhubQuote({ ...GOOD, t: Math.floor((FETCHED.getTime() - 31 * 60_000) / 1000) }, "AAPL", FETCHED);
  assert.equal(alertValidityLocal(stale, FETCHED), "行情过期或时间异常，未触价");
  // 未知字段仍拒绝（timestamp 等不在白名单）
  assert.equal(
    alertValidityLocal({ At: FETCHED, TimeField: "timestamp", AssetOK: true }, FETCHED),
    "缺少可用的行情时间字段，未触价",
  );
});

test("normalizeQuoteProvider：仅 finnhub 归一为 finnhub，其余回退 twelvedata", () => {
  assert.equal(normalizeQuoteProvider("finnhub"), "finnhub");
  assert.equal(normalizeQuoteProvider("twelvedata"), "twelvedata");
  assert.equal(normalizeQuoteProvider("alpha"), "twelvedata");
  assert.equal(normalizeQuoteProvider(""), "twelvedata");
  assert.equal(normalizeQuoteProvider(null), "twelvedata");
  assert.deepEqual(QUOTE_PROVIDERS, ["twelvedata", "finnhub"] as QuoteProvider[]);
});

test("store：quoteSourceOf 默认值与 saveQuoteSource 的校验/合并语义", () => {
  // 内存库：openDB() 无参会落到当前目录的持久化 ticker.db，测试间会互相污染。
  const db = openDB(undefined, ":memory:");
  const def = quoteSourceOf(db);
  assert.equal(def.provider, "twelvedata");
  assert.equal(def.twelvedataKey, "");
  assert.equal(def.finnhubKey, "");

  // 校验：非法 provider 拒绝并保持原值
  assert.throws(() => saveQuoteSource(db, "alpha-vantage", ""), /行情源无效/);
  assert.equal(quoteSourceOf(db).provider, "twelvedata");

  // 切到 finnhub 并写入 key；再次保存 provider 不变、key 留空保持原值
  saveQuoteSource(db, "finnhub", "fh_key_1");
  assert.deepEqual(quoteSourceOf(db), { provider: "finnhub", twelvedataKey: "", finnhubKey: "fh_key_1" });
  saveQuoteSource(db, "finnhub", "");
  assert.equal(quoteSourceOf(db).finnhubKey, "fh_key_1", "空 Key 保存保持现有值");

  // 切回 twelvedata 不动 finnhub key
  saveQuoteSource(db, "twelvedata", "");
  const back = quoteSourceOf(db);
  assert.equal(back.provider, "twelvedata");
  assert.equal(back.finnhubKey, "fh_key_1");
});
