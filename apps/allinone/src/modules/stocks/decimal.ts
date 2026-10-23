// 十进制价格工具：照 Go 版 shopspring/decimal 的语义实现，
// 全程用「符号 + BigInt 系数 + 10 的指数」表示，杜绝浮点误差。
// 比较与字符串格式化与 shopspring 对齐（StringFixed 四舍五入、远离零）。

export type Decimal = {
  sign: 1 | -1;
  mag: bigint; // 非负系数（0 时 sign 恒为 1）
  exp: number; // value = sign * mag * 10^exp
};

const DEC_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export function parseDecimal(raw: string): Decimal | null {
  if (raw === "" || raw.length > 327680) return null;
  const m = DEC_RE.exec(raw);
  if (!m) return null;
  const [, sign, intPart, fracPart, expPart] = m;
  if ((intPart ?? "") === "" && (fracPart ?? "") === "") return null;
  let exp = -((fracPart ?? "").length);
  if (expPart !== undefined && expPart !== "") {
    const e = Number(expPart);
    if (!Number.isSafeInteger(e)) return null;
    exp += e;
  }
  const digits = ((intPart ?? "") + (fracPart ?? "")).replace(/^0+(?=\d)/, "");
  const mag = BigInt(digits === "" ? "0" : digits);
  if (mag === 0n) return { sign: 1, mag: 0n, exp: 0 };
  return { sign: sign === "-" ? -1 : 1, mag, exp };
}

export function decFromInt(n: number): Decimal {
  return { sign: n < 0 ? -1 : 1, mag: BigInt(Math.abs(n)), exp: 0 };
}

const ONE = decFromInt(1);

function pow10(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}

function aligned(a: Decimal, b: Decimal): { am: bigint; bm: bigint; scale: number } {
  // 统一到更小的 10 的指数（更小的 exp = 更精确），只做整数放大不做除法。
  const scale = Math.min(a.exp, b.exp);
  const am = a.mag * pow10(a.exp - scale);
  const bm = b.mag * pow10(b.exp - scale);
  return { am, bm, scale };
}

export function cmpDec(a: Decimal, b: Decimal): number {
  if (a.sign !== b.sign) return a.sign - b.sign;
  const { am, bm } = aligned(a, b);
  const c = am === bm ? 0 : am < bm ? -1 : 1;
  return a.sign === 1 ? c : -c;
}

export function isPositive(d: Decimal): boolean {
  return d.sign > 0 && d.mag !== 0n;
}

export function isNegative(d: Decimal): boolean {
  return d.sign < 0 && d.mag !== 0n;
}

export function negate(d: Decimal): Decimal {
  return { sign: d.sign === 1 ? -1 : 1, mag: d.mag, exp: d.exp };
}

export function addDec(a: Decimal, b: Decimal): Decimal {
  const { am, bm, scale } = aligned(a, b);
  const sa = a.sign === 1 ? am : -am;
  const sb = b.sign === 1 ? bm : -bm;
  const sum = sa + sb;
  if (sum === 0n) return { sign: 1, mag: 0n, exp: 0 };
  return { sign: sum < 0n ? -1 : 1, mag: sum < 0n ? -sum : sum, exp: scale };
}

export function subDec(a: Decimal, b: Decimal): Decimal {
  return addDec(a, negate(b));
}

export function mulDec(a: Decimal, b: Decimal): Decimal {
  const sign = (a.sign * b.sign) as 1 | -1;
  if (a.mag === 0n || b.mag === 0n) return { sign: 1, mag: 0n, exp: 0 };
  return { sign, mag: a.mag * b.mag, exp: a.exp + b.exp };
}

// 除法：shopspring 默认 DivisionPrecision=16，中间结果四舍五入到 16 位小数。
export function divDec(a: Decimal, b: Decimal): Decimal {
  return divToScale(a, b, 16);
}

// 精确除到指定小数位，half away from zero。b 为 0 时抛错（调用侧保证非零）。
export function divToScale(a: Decimal, b: Decimal, scale: number): Decimal {
  if (b.mag === 0n) throw new Error("decimal division by zero");
  const e = a.exp - b.exp + scale;
  let num: bigint;
  let den: bigint;
  if (e >= 0) {
    num = a.mag * pow10(e);
    den = b.mag;
  } else {
    num = a.mag;
    den = b.mag * pow10(-e);
  }
  // half away from zero（对绝对值 half up）
  const q = (num * 2n + den) / (2n * den);
  if (q === 0n) return { sign: 1, mag: 0n, exp: 0 };
  return { sign: (a.sign * b.sign) as 1 | -1, mag: q, exp: -scale };
}

// 等价 shopspring 的 StringFixed(scale)：仅格式化时四舍五入，不改动存储值。
export function stringFixed(d: Decimal, scale: number): string {
  const scaled = divToScale(d, ONE, scale);
  const abs = scaled.mag;
  const p = pow10(scale);
  const intPart = abs / p;
  const fracPart = abs % p;
  const fracText = scale > 0 ? "." + fracPart.toString().padStart(scale, "0") : "";
  const signText = scaled.sign < 0 ? "-" : "";
  return `${signText}${intPart.toString()}${fracText}`;
}

// 等价 shopspring 的 String()：输出不带多余尾随零的规范十进制字符串
// （实测 NewFromString("101.2300").String() === "101.23"，"1.5e3" → "1500"）。
export function decString(d: Decimal): string {
  if (d.mag === 0n) return "0";
  let mag = d.mag;
  let exp = d.exp;
  // 指数为负时去掉系数的尾随零（每去一个零 exp 加一）。
  while (exp < 0 && mag % 10n === 0n) {
    mag /= 10n;
    exp += 1;
  }
  const digits = mag.toString();
  const signText = d.sign < 0 ? "-" : "";
  if (exp >= 0) return `${signText}${digits}${"0".repeat(exp)}`;
  const cut = digits.length + exp;
  if (cut > 0) {
    return `${signText}${digits.slice(0, cut)}.${digits.slice(cut)}`;
  }
  return `${signText}0.${"0".repeat(-cut)}${digits}`;
}
