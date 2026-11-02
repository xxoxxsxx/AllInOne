// 提醒事项投递组装与 Telegram 图片上传：
//   - buildChannelMessage：统一消息文案（[补发] 标记 + 文字 + 附件计数行）；
//   - sendTelegramPhoto：sendPhoto multipart 直传（复用 stocks notify 的代理与错误语义：
//     HTTP 代理走 undici ProxyAgent，SOCKS5 走 node:https + socks-proxy-agent；
//     multipart body 手工拼装，不依赖 fetch 的 FormData 序列化差异）。
// Bark / 飞书只发文字（sendChannel 文本路径），图片仅在 Telegram 以原生照片直传。

import https from "node:https";

import { SocksProxyAgent } from "socks-proxy-agent";
import { ProxyAgent, request as undiciRequest } from "undici";

import { channelProxy, type ChannelConfig, type SendOutcome } from "@/modules/stocks/notify";

export const REMINDERS_TITLE = "⏰ 提醒事项";
export const ALERT_TITLE = "提醒事项 · 投递失败";

/** Telegram sendPhoto 的 caption 上限（Bot API 硬限制 1024 字符）。 */
export const TG_CAPTION_LIMIT = 1024;

export type MessageLike = { text: string; imageCount: number };

/** 组装推送标题与正文：catchup 时标题带「[补发]」；有图片时正文追加附件计数行。 */
export function buildChannelMessage(reminder: MessageLike, catchup: boolean): { title: string; body: string } {
  const title = `${catchup ? "[补发] " : ""}${REMINDERS_TITLE}`;
  const text = reminder.text ?? "";
  const body = reminder.imageCount > 0 ? `${text}\n📎 ${reminder.imageCount} 张附件` : text;
  return { title, body };
}

// —— multipart 拼装（Buffer 化，代理路径通用） ——

export function buildMultipartBody(
  fields: Array<[string, string]>,
  file: { name: string; filename: string; mime: string; data: Buffer },
): { contentType: string; body: Buffer } {
  const boundary = `----allinone-reminders-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  const chunks: Buffer[] = [];
  const parts: string[] = [];
  for (const [name, value] of fields) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  chunks.push(Buffer.from(parts.join(""), "utf8"));
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename.replace(/["\r\n]/g, "_")}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      "utf8",
    ),
  );
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

function outcomeFromResponse(status: number, body: string): SendOutcome {
  if (!(status >= 200 && status < 300)) {
    switch (status) {
      case 400:
        return { status: "失败", error: "Telegram 拒绝请求 (HTTP 400)；请核对 Chat ID、图片格式与大小" };
      case 401:
      case 404:
        return { status: "失败", error: `Telegram 拒绝请求 (HTTP ${status})；请核对 Bot Token` };
      case 403:
        return { status: "失败", error: "Telegram 拒绝请求 (HTTP 403)；请在目标会话启动 Bot，或检查群内发送权限" };
      case 413:
        return { status: "失败", error: "Telegram 拒绝请求 (HTTP 413)；图片过大，请压缩后重试" };
      case 429:
        return { status: "失败", error: "Telegram 请求过于频繁 (HTTP 429)；请稍后重试" };
      default:
        return { status: "失败", error: `Telegram 拒绝请求 (HTTP ${status})` };
    }
  }
  let result: { ok?: boolean; description?: string };
  try {
    result = JSON.parse(body.slice(0, 4096)) as { ok?: boolean; description?: string };
  } catch {
    return { status: "不确定", error: "Telegram 响应无法确认" };
  }
  if (!result.ok) {
    return { status: "失败", error: `Telegram 拒绝请求${result.description ? `：${result.description}` : ""}` };
  }
  return { status: "成功", error: "" };
}

/**
 * sendTelegramPhoto：把一张图片作为照片直传到 Telegram（sendPhoto）。
 * caption = 标题 + 正文（超限截断）；代理语义与 stocks notify 的 sendTelegram 一致。
 */
export async function sendTelegramPhoto(
  config: ChannelConfig,
  buffer: Buffer,
  filename: string,
  caption: string,
  mime = "image/jpeg",
): Promise<SendOutcome> {
  const proxy = channelProxy(config, config.TGProxy);
  const endpoint = `https://api.telegram.org/bot${config.TGToken}/sendPhoto`;
  const trimmedCaption = caption.length > TG_CAPTION_LIMIT ? `${caption.slice(0, TG_CAPTION_LIMIT - 1)}…` : caption;
  const { contentType, body } = buildMultipartBody(
    [
      ["chat_id", config.TGChatID],
      ["caption", trimmedCaption],
    ],
    { name: "photo", filename, mime, data: buffer },
  );
  const timeoutMs = 30000;
  try {
    if (proxy.startsWith("socks5://")) {
      const agent = new SocksProxyAgent(proxy);
      try {
        const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = https.request(
            endpoint,
            { agent, method: "POST", headers: { "Content-Type": contentType }, timeout: timeoutMs },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            },
          );
          req.on("timeout", () => req.destroy(new Error("timeout")));
          req.on("error", reject);
          req.write(body);
          req.end();
        });
        return outcomeFromResponse(response.status, response.body);
      } finally {
        agent.destroy();
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await undiciRequest(endpoint, {
        method: "POST",
        headers: { "Content-Type": contentType, "Content-Length": String(body.length) },
        body,
        dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
        signal: controller.signal,
      });
      return outcomeFromResponse(r.statusCode, await r.body.text());
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("ENOTFOUND") || message.includes("EAI_AGAIN")) {
      return { status: "失败", error: "Telegram 域名解析失败；请检查 NAS 的 DNS 和容器网络" };
    }
    if (message.includes("ECONNREFUSED") || message.includes("EHOSTUNREACH") || message.includes("ENETUNREACH")) {
      return { status: "失败", error: "Telegram 连接失败；请检查到 api.telegram.org:443 的连通性及代理配置" };
    }
    if (message.includes("certificate") || message.includes("CERT")) {
      return { status: "失败", error: "Telegram HTTPS 证书校验失败；请检查时间、代理和证书配置" };
    }
    if (message.includes("timeout") || message.includes("aborted")) {
      return { status: "不确定", error: "Telegram 图片上传超时；请先到接收会话核对是否送达，再检查网络与代理" };
    }
    return { status: "不确定", error: "Telegram 图片上传中断，发送结果不确定；请先到接收会话核对" };
  }
}
