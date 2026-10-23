// Twelve Data REST 行情客户端（quote.go 语义一一对应）。
// - GET https://api.twelvedata.com/quote?symbol=...，Key 走 Authorization 头不进 URL。
// - 429（HTTP 或 body code=429）返回限流错误并携带 Retry-After 推导的等待时间。
// - 校验：匹配代码、USD、可识别交易所（AssetOK）、时间字段、年龄 -2～30 分钟（触价判定在 alertValidity）。
// - HTTP 代理用 undici ProxyAgent；SOCKS5 用 socks-proxy-agent。

import { ProxyAgent, request as undiciRequest, type Dispatcher } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";
import { Agent as HttpsAgent } from "node:https";

import { parseDecimal, isPositive, decString, type Decimal } from "./decimal";
import { parseRFC3339 } from "./tz";
import { calendarReviewed, isOpen, regularHours } from "./calendar";

export type Quote = {
  Symbol: string;
  Price: Decimal;
  Open: string;
  PrevClose: string;
  At: Date;
  Source: string;
  TimeField: string;
  Delay: string;
  AssetOK: boolean;
};

export class RateLimitError extends Error {
  afterMs: number;
  constructor(afterMs: number) {
    super("行情服务限流 (429)");
    this.afterMs = afterMs;
  }
}

// retryDelay：先按整数秒，再按 HTTP 日期；无效视为 0（Go retryDelay 语义）。
export function retryDelay(value: string, now: Date): number {
  const seconds = /^\d+$/.test(value) ? Number(value) : null;
  if (seconds !== null && seconds >= 0) return seconds * 1000;
  const parsed = value ? new Date(value) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return parsed.getTime() - now.getTime();
  }
  return 0;
}

function dispatcher(proxy: string): Dispatcher {
  if (proxy === "") return undefined as unknown as Dispatcher;
  if (proxy.startsWith("socks5://")) {
    // socks-proxy-agent 是 node http.Agent；undici 需要用其 Agent 包装不可行，
    // 因此 SOCKS5 走 node:http 原生请求路径由调用方（sendWithProxy）处理。
    return undefined as unknown as Dispatcher;
  }
  return new ProxyAgent(proxy);
}

// 统一出口：按代理类型选择 undici（HTTP 代理）或 node https（SOCKS5 代理）。
export async function httpGetJSON(
  url: string,
  headers: Record<string, string>,
  proxy: string,
  timeoutMs: number,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (proxy.startsWith("socks5://")) {
    const agent = new SocksProxyAgent(proxy);
    const https = await import("node:https");
    const body = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
      const req = https.request(
        url,
        { agent, method: "GET", headers, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => {
            if (chunks.reduce((n, b) => n + b.length, 0) < 64 * 1024) chunks.push(c);
          });
          res.on("end", () => {
            const h: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") h[k.toLowerCase()] = v;
              else if (Array.isArray(v) && v.length > 0) h[k.toLowerCase()] = String(v[0]);
            }
            resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks).toString("utf8") });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });
    agent.destroy();
    return body;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciRequest(url, {
      method: "GET",
      headers,
      dispatcher: proxy ? dispatcher(proxy) : undefined,
      signal: controller.signal,
    });
    const text = await response.body.text();
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers)) {
      if (typeof v === "string") responseHeaders[k.toLowerCase()] = v;
      else if (Array.isArray(v) && v.length > 0) responseHeaders[k.toLowerCase()] = String(v[0]);
    }
    return { status: response.statusCode, headers: responseHeaders, body: text };
  } catch {
    throw new Error("行情服务连接失败或超时");
  } finally {
    clearTimeout(timer);
  }
}

type RawQuote = {
  status?: string;
  code?: number;
  message?: string;
  symbol?: string;
  currency?: string;
  open?: string;
  close?: string;
  previous_close?: string;
  last_update_at?: string;
  last_quote_at?: number;
  exchange?: string;
  mic_code?: string;
  type?: string;
};

// 解析 open / previous_close：合法正数才保留（quote_prices_test 断言）。
export function parseOptionalPrice(raw: string | undefined): string {
  if (!raw) return "";
  const d = parseDecimal(raw);
  if (!d || !isPositive(d)) return "";
  return decString(d);
}

export async function fetchQuote(symbol: string, key: string, proxy: string, now: () => Date = () => new Date()): Promise<Quote> {
  const endpoint = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}`;
  const response = await httpGetJSON(endpoint, { Authorization: `apikey ${key}` }, proxy, 12000);
  if (response.status === 429) {
    throw new RateLimitError(retryDelay(response.headers["retry-after"] ?? "", now()));
  }
  if (response.status !== 200) {
    throw new Error(`行情服务 HTTP ${response.status}`);
  }
  let raw: RawQuote;
  try {
    raw = JSON.parse(response.body) as RawQuote;
  } catch {
    throw new Error("行情响应不是有效 JSON");
  }
  if (raw.status === "error" && raw.code === 429) {
    throw new RateLimitError(retryDelay(response.headers["retry-after"] ?? "", now()));
  }
  if (raw.status === "error") {
    throw new Error("行情服务拒绝请求：请检查代码、Key 或额度");
  }
  if (!raw.symbol || raw.symbol.toUpperCase() !== symbol.toUpperCase()) {
    throw new Error("行情代码与请求不匹配");
  }
  if (raw.currency !== "USD") {
    throw new Error("行情币种不是 USD");
  }
  if (!raw.close) {
    throw new Error("行情缺少价格");
  }
  const price = parseDecimal(raw.close);
  if (!price || !isPositive(price)) {
    throw new Error("行情价格无效");
  }
  const open = parseOptionalPrice(raw.open);
  const prevClose = parseOptionalPrice(raw.previous_close);
  let at: Date;
  let field: string;
  if (raw.last_update_at) {
    const parsed = parseRFC3339(raw.last_update_at);
    if (!parsed) throw new Error("行情更新时间格式或时区无效");
    at = parsed;
    field = "last_update_at";
  } else if (raw.last_quote_at && raw.last_quote_at > 0) {
    at = new Date(raw.last_quote_at * 1000);
    field = "last_quote_at";
  } else {
    throw new Error("行情缺少可信更新时间；不可用区间起点 timestamp 代替");
  }
  if (at.getTime() < Date.UTC(2000, 0, 1)) {
    throw new Error("行情更新时间无效");
  }
  if (at.getTime() > now().getTime() + 2 * 60 * 1000) {
    throw new Error("行情更新时间在未来");
  }
  const asset =
    !raw.type ||
    raw.type.toLowerCase() === "common stock" ||
    raw.type.toLowerCase() === "etf";
  const exchange = (raw.exchange ?? "").trim().toUpperCase();
  const usExchange =
    exchange === "NASDAQ" || exchange === "NYSE" || exchange === "NYSE ARCA" || exchange === "AMEX" ||
    exchange === "NYSE MKT" || exchange === "CBOE" || exchange === "BATS";
  const mic = (raw.mic_code ?? "").trim().toUpperCase();
  const usMIC =
    mic === "" || mic === "XNGS" || mic === "XNMS" || mic === "XNCM" || mic === "XNAS" ||
    mic === "XNYS" || mic === "ARCX" || mic === "XASE" || mic === "BATS" || mic === "EDGX";
  return {
    Symbol: symbol,
    Price: price,
    Open: open,
    PrevClose: prevClose,
    At: at,
    Source: "Twelve Data",
    TimeField: field,
    Delay: "未知",
    AssetOK: asset && usExchange && usMIC,
  };
}

// alertValidity（alert.go）：触价有效性的统一闸门。fetched 为本次查询完成时刻。
export function alertValidity(
  q: Pick<Quote, "At" | "TimeField" | "AssetOK">,
  fetched: Date,
  reviewed: (t: Date) => boolean,
  open: (t: Date) => boolean,
  regularHoursOf: (t: Date) => { open: Date; close: Date } | null,
): string {
  if (!reviewed(fetched) || !reviewed(q.At)) {
    return "交易日历超出已核验年份，未触价";
  }
  if (!open(fetched)) {
    return "市场休市，未触价";
  }
  if (q.TimeField !== "last_update_at" && q.TimeField !== "last_quote_at") {
    return "缺少可用的行情时间字段，未触价";
  }
  if (!q.AssetOK) {
    return "资产类型或交易所未核验，未执行价格提醒判断";
  }
  const hours = regularHoursOf(fetched);
  if (!hours || q.At.getTime() < hours.open.getTime() || q.At.getTime() >= hours.close.getTime()) {
    return "报价不属于当日常规时段，未触价";
  }
  const age = fetched.getTime() - q.At.getTime();
  if (age < -2 * 60 * 1000 || age > 30 * 60 * 1000) {
    return "行情过期或时间异常，未触价";
  }
  return "";
}

// 基于本地 calendar.ts 的 alertValidity 绑定（run.ts / readiness 使用）。
export function alertValidityLocal(q: Pick<Quote, "At" | "TimeField" | "AssetOK">, fetched: Date): string {
  return alertValidity(q, fetched, calendarReviewed, isOpen, regularHoursForDate);
}

function regularHoursForDate(t: Date): { open: Date; close: Date } | null {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(t);
  return regularHours(key);
}

// 保留类型引用，避免未使用告警（HttpsAgent 预留给未来直连优化）。
void HttpsAgent;
export { calendarReviewed, isOpen, regularHours };
