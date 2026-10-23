// 通知渠道：Bark / 飞书群机器人 / Telegram Bot（alert.go + channels.go 语义）。
// 渠道各自可选代理；「任一成功即占用额度」的聚合语义在调用侧（run.ts / alert）实现。
// Bark：HTTPS（或显式允许的内网 HTTP）；发送前做私网地址校验。
// 飞书：仅允许 open.feishu.cn 群自定义机器人；可选 HMAC-SHA256 签名（node:crypto）。
// Telegram：Bot Token + 数字 Chat ID；按状态码给出可读错误。

import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { ProxyAgent, request as undiciRequest } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";

const dnsLookup = (host: string) => lookup(host, { all: true });

export type ChannelStatus = "成功" | "失败" | "不确定";

export type SendOutcome = { status: ChannelStatus; error: string };

const TG_TOKEN_RE = /^[0-9]{5,15}:[A-Za-z0-9_-]{20,100}$/;
const TG_CHAT_RE = /^-?[0-9]{1,20}$/;
const FEISHU_HOOK_RE = /^[A-Za-z0-9_-]{8,128}$/;

export type BarkConfig = { URL: string; Key: string; Local: boolean };
export type ChannelConfig = {
  Bark: BarkConfig;
  BarkEnabled: boolean;
  FeishuWebhook: string;
  FeishuSecret: string;
  FeishuEnabled: boolean;
  TGToken: string;
  TGChatID: string;
  TGEnabled: boolean;
  Proxy: string;
  BarkProxy: boolean;
  FeishuProxy: boolean;
  TGProxy: boolean;
};

export function channelProxy(c: ChannelConfig, use: boolean): string {
  return use ? c.Proxy : "";
}

export function enabledChannels(c: ChannelConfig): string[] {
  const names: string[] = [];
  if (c.BarkEnabled && c.Bark.URL !== "" && c.Bark.Key !== "") names.push("Bark");
  if (c.FeishuEnabled && c.FeishuWebhook !== "") names.push("飞书");
  if (c.TGEnabled && c.TGToken !== "" && c.TGChatID !== "") names.push("Telegram");
  return names;
}

// —— URL/配置校验（照 Go checkBarkURL/checkFeishuWebhook/checkTG）——
export function checkBarkURL(raw: string, allowLocal: boolean): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error("Bark 地址须为 HTTPS 服务根地址；内网 HTTP 需显式允许");
  }
  const bad =
    trimmed.length > 2048 ||
    u.hostname === "" ||
    u.username !== "" ||
    u.search !== "" ||
    u.hash !== "" ||
    (u.pathname !== "" && u.pathname !== "/") ||
    (u.protocol !== "https:" && !(allowLocal && u.protocol === "http:"));
  if (bad) throw new Error("Bark 地址须为 HTTPS 服务根地址；内网 HTTP 需显式允许");
  const host = u.hostname.toLowerCase();
  if (!allowLocal) {
    const ip = net.isIP(host) ? privateIPClass(host) : null;
    if (host === "localhost" || ip) throw new Error("内网地址需显式允许");
  }
  return trimmed;
}

function privateIPClass(host: string): boolean {
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (net.isIPv6(host)) {
    const lower = host.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd");
  }
  return false;
}

export function checkFeishuWebhook(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error("飞书 Webhook 须为 open.feishu.cn 的群自定义机器人地址");
  }
  const hook = u.pathname.startsWith("/open-apis/bot/v2/hook/")
    ? u.pathname.slice("/open-apis/bot/v2/hook/".length)
    : "";
  const bad =
    trimmed.length > 512 ||
    u.protocol !== "https:" ||
    u.host !== "open.feishu.cn" ||
    u.username !== "" ||
    u.search !== "" ||
    u.hash !== "" ||
    !u.pathname.startsWith("/open-apis/bot/v2/hook/") ||
    !FEISHU_HOOK_RE.test(hook);
  if (bad) throw new Error("飞书 Webhook 须为 open.feishu.cn 的群自定义机器人地址");
  return trimmed;
}

export function checkTG(token: string, chat: string): void {
  if (!TG_TOKEN_RE.test(token) || !TG_CHAT_RE.test(chat)) {
    throw new Error("Telegram Bot Token 或数字 Chat ID 格式无效");
  }
}

// —— 代理校验（proxy.go checkProxy）——
export function checkProxy(raw: string): string {
  let text = raw.trim();
  if (text === "") return "";
  if (!text.includes("://")) text = `http://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error("代理地址须为 HTTP 或 SOCKS5 的地址和端口，不支持账号密码");
  }
  if (
    text.length > 256 ||
    (u.protocol !== "http:" && u.protocol !== "socks5:") ||
    u.hostname === "" ||
    u.username !== "" ||
    (u.pathname !== "" && u.pathname !== "/") ||
    u.search !== "" ||
    u.hash !== ""
  ) {
    throw new Error("代理地址须为 HTTP 或 SOCKS5 的地址和端口，不支持账号密码");
  }
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("代理端口须为 1～65535");
  }
  return u.toString().replace(/\/$/, "");
}

// —— POST JSON 公共（10 秒超时，不跟随重定向）——
async function postJSON(
  endpoint: string,
  payload: unknown,
  channel: string,
  proxy: string,
  timeoutMs = 10000,
): Promise<{ status: number; body: string }> {
  let response: { status: number; body: string };
  if (proxy.startsWith("socks5://")) {
    const agent = new SocksProxyAgent(proxy);
    const https = await import("node:https");
    const data = JSON.stringify(payload);
    response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request(
        endpoint,
        { agent, method: "POST", headers: { "Content-Type": "application/json" }, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.write(data);
      req.end();
    }).finally(() => agent.destroy());
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await undiciRequest(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
        signal: controller.signal,
      });
      response = { status: r.statusCode, body: await r.body.text() };
    } catch {
      throw new Error(`${channel} 请求无效`);
    } finally {
      clearTimeout(timer);
    }
  }
  return response;
}

function httpStatusText(status: number): boolean {
  return status >= 200 && status < 300;
}

// —— Bark ——
export async function sendBark(b: BarkConfig, title: string, body: string, proxy: string): Promise<SendOutcome> {
  const payload = { device_key: b.Key, title, body, group: "TickerSentry" };
  let endpoint: URL;
  try {
    endpoint = new URL(`${b.URL}/push`);
  } catch {
    return { status: "失败", error: "Bark 请求无效" };
  }
  // 发送前解析并校验 Bark 目标（Go sendBark 的 DNS 检查）。
  const host = endpoint.hostname;
  let ips: string[];
  try {
    // 容器内 DNS 转发链路偶发抖动：失败后短暂等待重试一次（语义不变）。
    try {
      ips = (await dnsLookup(host)).map((r) => r.address);
    } catch {
      await new Promise((r) => setTimeout(r, 300));
      ips = (await dnsLookup(host)).map((r) => r.address);
    }
  } catch {
    return { status: "失败", error: "Bark 域名解析失败" };
  }
  let allowed: string | null = null;
  for (const ip of ips) {
    const isPrivate = privateIPClass(ip);
    if (b.Local || (!isPrivate && isGlobalUnicast(ip))) {
      allowed = ip;
      break;
    }
  }
  if (!allowed) return { status: "失败", error: "Bark 地址指向内网，需显式允许" };
  try {
    const response = await postJSON(`${b.URL}/push`, payload, "Bark", proxy);
    if (!httpStatusText(response.status)) {
      return { status: "失败", error: `Bark HTTP ${response.status}` };
    }
    let result: { code?: number; message?: string };
    try {
      result = JSON.parse(response.body.slice(0, 4096)) as { code?: number; message?: string };
    } catch {
      return { status: "不确定", error: "Bark 响应无法确认" };
    }
    if (result.code !== 200 || (result.message ?? "").toLowerCase() !== "success") {
      return { status: "失败", error: `Bark 拒绝请求 (code ${result.code ?? 0})` };
    }
    return { status: "成功", error: "" };
  } catch {
    return { status: "不确定", error: "Bark 网络异常或超时，发送结果不确定" };
  }
}

function isGlobalUnicast(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a] = ip.split(".").map(Number);
    return a !== 0 && a !== 127 && a !== 10 && a !== 224 && a !== 255 && ip !== "255.255.255.255";
  }
  const lower = ip.toLowerCase();
  return !(lower === "::1" || lower.startsWith("fe80") || lower.startsWith("ff") || lower.startsWith("fc") || lower.startsWith("fd"));
}

// —— 飞书 ——
export async function sendFeishu(webhook: string, secret: string, text: string, proxy: string): Promise<SendOutcome> {
  const payload: Record<string, unknown> = { msg_type: "text", content: { text } };
  if (secret !== "") {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const mac = crypto.createHmac("sha256", `${timestamp}\n${secret}`).update("").digest();
    payload.timestamp = timestamp;
    payload.sign = mac.toString("base64");
  }
  try {
    const response = await postJSON(webhook, payload, "飞书", proxy);
    if (!httpStatusText(response.status)) {
      return { status: "失败", error: `飞书 HTTP ${response.status}` };
    }
    let result: { code?: number; StatusCode?: number };
    try {
      result = JSON.parse(response.body.slice(0, 4096)) as { code?: number; StatusCode?: number };
    } catch {
      return { status: "不确定", error: "飞书响应无法确认" };
    }
    if (result.code === undefined && result.StatusCode === undefined) {
      return { status: "不确定", error: "飞书响应无法确认" };
    }
    if (result.code !== undefined && result.code !== 0) {
      return { status: "失败", error: `飞书拒绝请求 (code ${result.code})` };
    }
    if (result.StatusCode !== undefined && result.StatusCode !== 0) {
      return { status: "失败", error: `飞书拒绝请求 (code ${result.StatusCode})` };
    }
    return { status: "成功", error: "" };
  } catch {
    return { status: "不确定", error: "飞书网络异常或超时，发送结果不确定" };
  }
}

// —— Telegram ——
export async function sendTelegram(token: string, chat: string, text: string, proxy: string): Promise<SendOutcome> {
  try {
    const response = await postJSON(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text }, "Telegram", proxy);
    if (!httpStatusText(response.status)) {
      switch (response.status) {
        case 400:
          return { status: "失败", error: "Telegram 拒绝请求 (HTTP 400)；请核对 Chat ID 和目标会话" };
        case 401:
        case 404:
          return { status: "失败", error: `Telegram 拒绝请求 (HTTP ${response.status})；请核对 Bot Token` };
        case 403:
          return { status: "失败", error: "Telegram 拒绝请求 (HTTP 403)；请在目标会话启动 Bot，或检查群内发送权限" };
        case 429:
          return { status: "失败", error: "Telegram 请求过于频繁 (HTTP 429)；请稍后重试" };
        default:
          return { status: "失败", error: `Telegram 拒绝请求 (HTTP ${response.status})` };
      }
    }
    let result: { ok?: boolean };
    try {
      result = JSON.parse(response.body.slice(0, 4096)) as { ok?: boolean };
    } catch {
      return { status: "不确定", error: "Telegram 响应无法确认" };
    }
    if (!result.ok) return { status: "失败", error: "Telegram 拒绝请求" };
    return { status: "成功", error: "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("ENOTFOUND") || message.includes("EAI_AGAIN")) {
      return { status: "失败", error: "Telegram 域名解析失败；请检查 NAS 的 DNS 和容器网络" };
    }
    if (message.includes("ECONNREFUSED") || message.includes("EHOSTUNREACH") || message.includes("ENETUNREACH")) {
      return { status: "失败", error: "Telegram 连接失败；请检查 NAS 到 api.telegram.org:443 的连通性及代理配置" };
    }
    if (message.includes("certificate") || message.includes("CERT")) {
      return { status: "失败", error: "Telegram HTTPS 证书校验失败；请检查 NAS 时间、代理和证书配置" };
    }
    if (message.includes("timeout") || message.includes("aborted")) {
      return { status: "不确定", error: "Telegram 请求超时；请先到接收会话核对是否送达，再检查 NAS 到 api.telegram.org:443 的连通性" };
    }
    return { status: "不确定", error: "Telegram 网络请求中断，发送结果不确定；请先到接收会话核对，再检查 NAS 容器网络" };
  }
}

// send：渠道分发（channelConfig.send 语义）。
export async function sendChannel(c: ChannelConfig, name: string, title: string, body: string): Promise<SendOutcome> {
  switch (name) {
    case "Bark":
      return sendBark(c.Bark, title, body, channelProxy(c, c.BarkProxy));
    case "飞书":
      return sendFeishu(c.FeishuWebhook, c.FeishuSecret, `${title}\n${body}`, channelProxy(c, c.FeishuProxy));
    case "Telegram":
      return sendTelegram(c.TGToken, c.TGChatID, `${title}\n${body}`, channelProxy(c, c.TGProxy));
    default:
      return { status: "失败", error: "通知渠道无效" };
  }
}

// channelStatus：全部成功→成功；有成功→部分成功；有不确定/发送中→不确定；否则失败。
export function channelStatus(results: Array<{ Name: string; Status: string; Error: string }>): string {
  let success = 0;
  let uncertain = 0;
  for (const r of results) {
    if (r.Status === "成功") success++;
    if (r.Status === "不确定" || r.Status === "发送中") uncertain++;
  }
  if (success === results.length) return "成功";
  if (success > 0) return "部分成功";
  if (uncertain > 0) return "不确定";
  return "失败";
}

// testProxy（proxy.go）：经代理访问 Telegram，返回耗时 ms；期望 HTTP 401。
export async function testProxy(proxy: string, timeoutMs = 7000): Promise<string> {
  const start = Date.now();
  try {
    const response = await postJSON("https://api.telegram.org/bot0:invalid/getMe", {}, "代理测试", proxy, timeoutMs);
    if (response.status !== 401) {
      throw new Error(`Telegram 连通性检查返回 HTTP ${response.status}`);
    }
    return String(Date.now() - start);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.startsWith("Telegram 连通性检查返回")) throw err;
    if (message.includes("timeout")) {
      throw new Error("代理连接超时；检查软路由地址、端口、允许局域网连接及分流规则");
    }
    throw new Error("代理无法访问外网；检查软路由地址、端口、允许局域网连接及分流规则");
  }
}
