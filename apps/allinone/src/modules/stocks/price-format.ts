// 展示格式化：formatPrice 仅四舍五入展示值，存储值保留精度（price_format.go）。

import { parseDecimal, stringFixed } from "./decimal";

export function formatPrice(raw: string): string {
  if (raw === "") return "";
  const price = parseDecimal(raw);
  if (!price) return "—";
  return stringFixed(price, 2);
}
