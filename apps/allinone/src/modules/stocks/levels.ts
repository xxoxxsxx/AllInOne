// 档位业务规则（levels.go 中与存储无关的部分）：
// parseTarget 目标价校验（正数、最多 4 位小数、< 1e9、拒绝科学计数法）。

import { cmpDec, decFromInt, isPositive, parseDecimal, decString } from "./decimal";

const MAX_TARGET = 1000000000;

export function parseTarget(input: string): string {
  const text = input.trim();
  if (text.length === 0 || text.length > 32 || /[eE]/.test(text)) {
    throw new Error("目标价必须是正数，最多 4 位小数");
  }
  const d = parseDecimal(text);
  if (!d || !isPositive(d) || d.exp < -4 || cmpDec(d, decFromInt(MAX_TARGET)) > 0) {
    throw new Error("目标价必须是正数，最多 4 位小数且小于十亿");
  }
  return decString(d);
}

// 股票代码 / 备注校验（web.go stockFields）。
export const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,14}$/;

export function checkStockFields(symbolRaw: string, note: string): string {
  const symbol = symbolRaw.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol) || note.length > 200) {
    throw new Error("股票代码或备注无效");
  }
  return symbol;
}
