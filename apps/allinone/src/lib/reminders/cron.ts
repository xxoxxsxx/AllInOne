// 提醒事项 cron 引擎（纯函数、零依赖）：解析与计算标准 5 字段 cron 表达式（分 时 日 月 周）。
// 语义对齐 vixie-cron：
//   - 支持 * , - / ：列表、区间与步进（a/step 视作 a-max/step，与 vixie 一致）；
//   - 字段范围：分 0-59、时 0-23、日 1-31、月 1-12、周 0-7（0 与 7 都表示周日）；
//   - 日（dom）与周（dow）同时受限时取「或」（标准 vixie 行为）；
//     任一字段以 * 开头（含星号加步进，如 “*” 后接 “/2”）视为「未受限」，此时取「与」；
//   - 计算全部使用「服务器本地时间」（容器内为 Asia/Shanghai），
//     直接依赖 Date 的本地时间字段；服务时区无夏令时（Asia/Shanghai），
//     其他时区下不存在/重复的墙钟时间按 Date 归一化处理（简单可预期）。
// nextFire 返回严格晚于 after 的下一次触发（逐日搜索，最多约 41 年，覆盖 400 年历法周期内
// 所有「月-日-星期」组合；如 0 0 29 2 1）；找不到返回 null（例如 0 0 31 2 * 永不触发）。

export type CronFields = {
  /** 允许的分钟集合（升序去重，周日已归一为 0）。 */
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  /** 周几（0=周日；7 输入归一为 0）。 */
  dow: number[];
  /** 日字段是否以 * 开头（含星号加步进，如 “*” 后接 “/2”）——用于 dom/dow 与/或判定。 */
  domStar: boolean;
  /** 周字段是否以 * 开头。 */
  dowStar: boolean;
};

export type CronParseResult = { ok: true; fields: CronFields } | { ok: false; error: string };

const FIELD_NAMES = ["分钟", "小时", "日", "月", "周"] as const;
const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(raw: string, index: number): { ok: true; values: number[]; star: boolean } | { ok: false; error: string } {
  const name = FIELD_NAMES[index];
  const [min, max] = FIELD_RANGES[index];
  const star = raw.startsWith("*");
  const values = new Set<number>();
  for (const term of raw.split(",")) {
    if (term === "") return { ok: false, error: `${name}字段存在空列表项` };
    let body = term;
    let step = 1;
    const slash = term.indexOf("/");
    if (slash >= 0) {
      body = term.slice(0, slash);
      const stepRaw = term.slice(slash + 1);
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) {
        return { ok: false, error: `${name}字段步进无效：${stepRaw}` };
      }
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(body)) {
      lo = Number(body);
      hi = slash >= 0 ? max : lo;
    } else if (/^\d+-\d+$/.test(body)) {
      const [a, b] = body.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      return { ok: false, error: `${name}字段无效：${term}` };
    }
    if (lo < min || hi > max) {
      return { ok: false, error: `${name}字段超出范围（允许 ${min}-${max}）：${term}` };
    }
    if (lo > hi) {
      return { ok: false, error: `${name}字段区间起止颠倒：${term}` };
    }
    for (let v = lo; v <= hi; v += step) values.add(index === 4 && v === 7 ? 0 : v);
  }
  if (values.size === 0) return { ok: false, error: `${name}字段为空` };
  return { ok: true, values: [...values].sort((a, b) => a - b), star };
}

/** parseCron：解析 5 字段 cron 表达式；失败返回中文错误，供编辑器即时展示。 */
export function parseCron(expr: string): CronParseResult {
  const trimmed = (expr ?? "").trim().replace(/\s+/g, " ");
  if (trimmed === "") return { ok: false, error: "cron 表达式不能为空" };
  const parts = trimmed.split(" ");
  if (parts.length !== 5) {
    return { ok: false, error: `字段数须为 5（分 时 日 月 周），当前 ${parts.length} 个` };
  }
  const parsed: Array<{ values: number[]; star: boolean }> = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i], i);
    if (!r.ok) return r;
    parsed.push(r);
  }
  const [minute, hour, dom, month, dow] = parsed;
  return {
    ok: true,
    fields: {
      minute: minute.values,
      hour: hour.values,
      dom: dom.values,
      month: month.values,
      dow: dow.values,
      domStar: dom.star,
      dowStar: dow.star,
    },
  };
}

function matchesDay(f: CronFields, year: number, month1: number, day: number): boolean {
  if (!f.month.includes(month1)) return false;
  const domOk = f.dom.includes(day);
  // getDay()：0=周日，本地时间。
  const dowOk = f.dow.includes(new Date(year, month1 - 1, day).getDay());
  if (f.domStar || f.dowStar) return domOk && dowOk;
  return domOk || dowOk;
}

/**
 * nextFire：严格晚于 after 的下一次触发（服务器本地时间）。
 * 逐日搜索（最多 ~41 年），日匹配后按 时/分 集合升序找第一个候选时刻。
 */
export function nextFire(expr: string, after: Date): Date | null {
  const parsed = parseCron(expr);
  if (!parsed.ok) return null;
  const f = parsed.fields;
  const afterMs = after.getTime();
  const start = new Date(afterMs);
  let year = start.getFullYear();
  let month1 = start.getMonth() + 1;
  let day = start.getDate();
  const MAX_DAYS = 15000; // ~41 年，覆盖 400 年周期内任意 月-日-星期 组合。
  for (let i = 0; i < MAX_DAYS; i++) {
    if (year > 2200) return null;
    if (matchesDay(f, year, month1, day)) {
      const sameDay = year === start.getFullYear() && month1 === start.getMonth() + 1 && day === start.getDate();
      const fromHour = sameDay ? start.getHours() : 0;
      const fromMinute = sameDay ? start.getMinutes() : 0;
      for (const h of f.hour) {
        if (h < fromHour) continue;
        const mStart = h === fromHour ? fromMinute : 0;
        for (const m of f.minute) {
          if (m < mStart) continue;
          const candidate = new Date(year, month1 - 1, day, h, m, 0, 0);
          // 分钟集合升序扫描：早于起点秒数（after 秒位 >0）的时刻继续向后找。
          if (candidate.getTime() > afterMs) return candidate;
        }
      }
    }
    day++;
    const dim = new Date(year, month1, 0).getDate();
    if (day > dim) {
      day = 1;
      month1++;
      if (month1 > 12) {
        month1 = 1;
        year++;
      }
    }
  }
  return null;
}

/** nextFires：after 之后的 n 次触发（升序）；解析失败返回空数组。 */
export function nextFires(expr: string, after: Date, n = 5): Date[] {
  const count = Math.max(0, Math.floor(n));
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextFire(expr, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * countSkippedCronOccurrences：统计 (from, until] 内被跳过的触发次数（不包含 from 本身）。
 * 供停机补发语义使用：最近一次错过的时间点仍会以「补发」推送，更早的记入跳过统计。
 * 上限 cap 防止高频 cron 长时间停机时无限扫描。
 */
export function countSkippedCronOccurrences(expr: string, from: Date, until: Date, cap = 1000): number {
  const untilMs = until.getTime();
  let cursor = from;
  let count = 0;
  for (;;) {
    const next = nextFire(expr, cursor);
    if (!next || next.getTime() > untilMs) break;
    count++;
    if (count >= cap) return cap;
    cursor = next;
  }
  return count;
}
