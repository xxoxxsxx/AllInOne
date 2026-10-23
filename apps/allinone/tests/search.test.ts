import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesQuery } from "../src/lib/search.ts";

test("空查询与空白查询匹配一切", () => {
  const fields = { name: "CDK 台账", description: "业务记录", tags: [], aliases: [] };
  assert.equal(matchesQuery(fields, ""), true);
  assert.equal(matchesQuery(fields, "   "), true);
});

test("名称命中，忽略大小写与首尾空格", () => {
  const fields = { name: "CDK Ledger", description: "台账", tags: [], aliases: [] };
  assert.equal(matchesQuery(fields, " cdk "), true);
  assert.equal(matchesQuery(fields, "ledger"), true);
  assert.equal(matchesQuery(fields, "LEDGER"), true);
});

test("多关键词全部匹配，可分布在不同字段", () => {
  const fields = { name: "股票提醒", description: "档位触价监控", tags: ["行情"], aliases: ["TickerSentry"] };
  assert.equal(matchesQuery(fields, "股票 行情"), true);
  assert.equal(matchesQuery(fields, "股票 tickersentry"), true);
  assert.equal(matchesQuery(fields, "股票 不存在"), false);
});

test("未命中返回 false", () => {
  const fields = { name: "CDK 台账", description: "业务记录", tags: ["cdk"], aliases: [] };
  assert.equal(matchesQuery(fields, "股票"), false);
  assert.equal(matchesQuery(fields, "zzz"), false);
});
