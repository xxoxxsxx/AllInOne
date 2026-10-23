// price_format_test 翻译 + decimal 语义补充（Go price_format_test.go）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatPrice } from "../../src/modules/stocks/price-format.ts";
import { cmpDec, parseDecimal, decString, stringFixed, divDec, mulDec, subDec, decFromInt } from "../../src/modules/stocks/decimal.ts";

test("formatPrice 展示四舍五入、存储精度保留（Go TestFormatPrice）", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["100", "100.00"],
    ["1.2", "1.20"],
    ["101.2349", "101.23"],
    ["101.235", "101.24"],
    ["9.999", "10.00"],
    ["0.001", "0.00"],
    ["invalid", "—"],
  ];
  for (const [input, want] of cases) {
    assert.equal(formatPrice(input), want, `formatPrice(${input})`);
  }
});

test("decimal 比较与 shopspring 语义一致（含精度不同的等值）", () => {
  assert.equal(cmpDec(parseDecimal("103.00")!, parseDecimal("103")!), 0);
  assert.equal(cmpDec(parseDecimal("0.10")!, parseDecimal("0.1")!), 0);
  assert.ok(cmpDec(parseDecimal("9.999")!, parseDecimal("10")!) < 0);
  assert.ok(cmpDec(parseDecimal("-0.5")!, parseDecimal("0")!) < 0);
  assert.equal(decString(parseDecimal("101.2300")!), "101.23");
  assert.equal(decString(parseDecimal("103")!), "103");
  assert.equal(decString(parseDecimal("1.5e3")!), "1500");
});

test("除法/乘法精度（收益百分比语义）", () => {
  const delta = subDec(parseDecimal("110")!, parseDecimal("100")!);
  const pct = mulDec(divDec(delta, parseDecimal("100")!), decFromInt(100));
  assert.equal(stringFixed(pct, 2), "10.00");
  const d2 = subDec(parseDecimal("100.50")!, parseDecimal("99.99")!);
  assert.equal(stringFixed(d2, 2), "0.51");
});
