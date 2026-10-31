// 证件到期提醒渠道配置：独立保存在证件夹数据库（documents.db 的 reminder_channels 表），
// 与行情（TickerSentry）设置零运行时依赖 —— 默认推送路径只读本库，不读 stocks 库。
// 复用的只有 stocks notify 的纯发送/校验函数（sendChannel/enabledChannels/check*），
// ChannelConfig 形状与 stocks 一致（类型引用，不含存储）。
//
// 表通过 CREATE TABLE IF NOT EXISTS 惰性创建（不动 documents 迁移链 / user_version）。
// 保存采用「合并语义」：文本字段（URL/Key/Webhook/Secret/Token/ChatID/代理）缺省或留空
// 表示「保持现有值」（服务端永远不把机密回传客户端，客户端表单里未重填即保持）；
// 开关类布尔字段总是按提交值应用。非空值经 stocks notify 的 check* 校验（中文报错）。
// 「从行情设置导入」是一次性显式操作（importChannelsFromStocks）：动态加载 stocks store
// 读取 notificationSettings 并整行覆盖（含空值清空），失败（库缺失/损坏）返回 ok:false。

import type Database from "better-sqlite3";

import {
  checkBarkURL,
  checkFeishuWebhook,
  checkProxy,
  checkTG,
  type ChannelConfig,
} from "@/modules/stocks/notify";

/** 面板展示用的渠道摘要：绝不含 Key/Token/Webhook 等机密（Bark 仅暴露主机名）。 */
export type ReminderChannelsSummary = {
  bark: { enabled: boolean; local: boolean; configured: boolean; host: string; useProxy: boolean };
  feishu: { enabled: boolean; configured: boolean; useProxy: boolean };
  telegram: { enabled: boolean; configured: boolean; useProxy: boolean };
  proxy: { configured: boolean };
};

/** 保存入参：全部可选。文本字段 undefined/留空 = 保持现有值；布尔字段缺省 = 保持现有值。 */
export type ReminderChannelsInput = {
  barkEnabled?: boolean;
  barkUrl?: string;
  barkKey?: string;
  barkLocal?: boolean;
  barkProxy?: boolean;
  feishuEnabled?: boolean;
  feishuWebhook?: string;
  feishuSecret?: string;
  feishuProxy?: boolean;
  tgEnabled?: boolean;
  tgToken?: string;
  tgChatId?: string;
  tgProxy?: boolean;
  proxyUrl?: string;
};

export function ensureReminderChannelsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_channels (
      id INTEGER PRIMARY KEY CHECK(id=1),
      bark_url TEXT NOT NULL DEFAULT '',
      bark_key TEXT NOT NULL DEFAULT '',
      bark_local INTEGER NOT NULL DEFAULT 0,
      bark_enabled INTEGER NOT NULL DEFAULT 0,
      feishu_webhook TEXT NOT NULL DEFAULT '',
      feishu_secret TEXT NOT NULL DEFAULT '',
      feishu_enabled INTEGER NOT NULL DEFAULT 0,
      tg_token TEXT NOT NULL DEFAULT '',
      tg_chat_id TEXT NOT NULL DEFAULT '',
      tg_enabled INTEGER NOT NULL DEFAULT 0,
      proxy_url TEXT NOT NULL DEFAULT '',
      bark_proxy INTEGER NOT NULL DEFAULT 0,
      feishu_proxy INTEGER NOT NULL DEFAULT 0,
      tg_proxy INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT OR IGNORE INTO reminder_channels(id) VALUES(1);
  `);
}

function rowToConfig(r: {
  bark_url: string; bark_key: string; bark_local: number; bark_enabled: number;
  feishu_webhook: string; feishu_secret: string; feishu_enabled: number;
  tg_token: string; tg_chat_id: string; tg_enabled: number;
  proxy_url: string; bark_proxy: number; feishu_proxy: number; tg_proxy: number;
}): ChannelConfig {
  return {
    Bark: { URL: r.bark_url, Key: r.bark_key, Local: Number(r.bark_local) === 1 },
    BarkEnabled: Number(r.bark_enabled) === 1,
    FeishuWebhook: r.feishu_webhook,
    FeishuSecret: r.feishu_secret,
    FeishuEnabled: Number(r.feishu_enabled) === 1,
    TGToken: r.tg_token,
    TGChatID: r.tg_chat_id,
    TGEnabled: Number(r.tg_enabled) === 1,
    Proxy: r.proxy_url,
    BarkProxy: Number(r.bark_proxy) === 1,
    FeishuProxy: Number(r.feishu_proxy) === 1,
    TGProxy: Number(r.tg_proxy) === 1,
  };
}

const CHANNELS_SELECT = `
  SELECT bark_url,bark_key,bark_local,bark_enabled,
         feishu_webhook,feishu_secret,feishu_enabled,
         tg_token,tg_chat_id,tg_enabled,
         proxy_url,bark_proxy,feishu_proxy,tg_proxy
  FROM reminder_channels WHERE id=1`;

/** 读取证件夹自己的渠道配置；表不存在时自动建表并返回全空配置（全部渠道未启用）。 */
export function getReminderChannels(db: Database.Database): ChannelConfig {
  ensureReminderChannelsSchema(db);
  const r = db.prepare(CHANNELS_SELECT).get() as Parameters<typeof rowToConfig>[0] | undefined;
  if (!r) {
    return {
      Bark: { URL: "", Key: "", Local: false },
      BarkEnabled: false,
      FeishuWebhook: "", FeishuSecret: "", FeishuEnabled: false,
      TGToken: "", TGChatID: "", TGEnabled: false,
      Proxy: "", BarkProxy: false, FeishuProxy: false, TGProxy: false,
    };
  }
  return rowToConfig(r);
}

/** 整行写入（导入用：含空值，真正「覆盖」）；调用方自行保证值合法。 */
function writeChannelsRow(db: Database.Database, config: ChannelConfig): void {
  ensureReminderChannelsSchema(db);
  db.prepare(
    `INSERT INTO reminder_channels(
       id,bark_url,bark_key,bark_local,bark_enabled,
       feishu_webhook,feishu_secret,feishu_enabled,
       tg_token,tg_chat_id,tg_enabled,
       proxy_url,bark_proxy,feishu_proxy,tg_proxy,updated_at)
     VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       bark_url=excluded.bark_url, bark_key=excluded.bark_key, bark_local=excluded.bark_local,
       bark_enabled=excluded.bark_enabled, feishu_webhook=excluded.feishu_webhook,
       feishu_secret=excluded.feishu_secret, feishu_enabled=excluded.feishu_enabled,
       tg_token=excluded.tg_token, tg_chat_id=excluded.tg_chat_id, tg_enabled=excluded.tg_enabled,
       proxy_url=excluded.proxy_url, bark_proxy=excluded.bark_proxy,
       feishu_proxy=excluded.feishu_proxy, tg_proxy=excluded.tg_proxy,
       updated_at=excluded.updated_at`,
  ).run(
    config.Bark.URL, config.Bark.Key, config.Bark.Local ? 1 : 0, config.BarkEnabled ? 1 : 0,
    config.FeishuWebhook, config.FeishuSecret, config.FeishuEnabled ? 1 : 0,
    config.TGToken, config.TGChatID, config.TGEnabled ? 1 : 0,
    config.Proxy, config.BarkProxy ? 1 : 0, config.FeishuProxy ? 1 : 0, config.TGProxy ? 1 : 0,
    new Date().toISOString(),
  );
}

/** 文本合并：undefined / 留空 → 保持现有值（机密不回传客户端，留空即「不修改」）。 */
function mergeText(value: string | undefined, current: string): string {
  if (value === undefined || value === null) return current;
  const trimmed = String(value).trim();
  return trimmed === "" ? current : trimmed;
}

function mergeBool(value: boolean | undefined, current: boolean): boolean {
  return value === undefined ? current : value === true;
}

/**
 * 合并保存渠道配置：文本字段留空/缺省保持现有值，布尔字段按提交值应用；
 * 非空值经 stocks notify 校验（中文报错），校验失败不落库。返回保存后的完整配置。
 */
export function saveReminderChannels(db: Database.Database, input: ReminderChannelsInput): ChannelConfig {
  ensureReminderChannelsSchema(db);
  const cur = getReminderChannels(db);
  const barkEnabled = mergeBool(input.barkEnabled, cur.BarkEnabled);
  const barkUrl = mergeText(input.barkUrl, cur.Bark.URL);
  const barkKey = mergeText(input.barkKey, cur.Bark.Key);
  const barkLocal = mergeBool(input.barkLocal, cur.Bark.Local);
  const feishuWebhook = mergeText(input.feishuWebhook, cur.FeishuWebhook);
  const feishuSecret = mergeText(input.feishuSecret, cur.FeishuSecret);
  const tgToken = mergeText(input.tgToken, cur.TGToken);
  const tgChatId = mergeText(input.tgChatId, cur.TGChatID);
  const proxyUrl = mergeText(input.proxyUrl, cur.Proxy);

  // 校验合并后的值（与 stocks 设置页一致：非空才校验；Bark 允许内网开关参与校验）。
  const url = barkUrl === "" ? "" : checkBarkURL(barkUrl, barkLocal);
  const webhook = feishuWebhook === "" ? "" : checkFeishuWebhook(feishuWebhook);
  if ((tgToken === "") !== (tgChatId === "")) {
    throw new Error("Telegram 需同时填写 Bot Token 和数字 Chat ID（留空则保持现有值）");
  }
  if (tgToken !== "") checkTG(tgToken, tgChatId);
  if (barkKey.length > 1024 || feishuSecret.length > 1024) throw new Error("密钥不能超过 1024 个字符");
  const proxy = proxyUrl === "" ? "" : checkProxy(proxyUrl);

  const next: ChannelConfig = {
    Bark: { URL: url, Key: barkKey, Local: barkLocal },
    BarkEnabled: barkEnabled,
    FeishuWebhook: webhook,
    FeishuSecret: feishuSecret,
    FeishuEnabled: mergeBool(input.feishuEnabled, cur.FeishuEnabled),
    TGToken: tgToken,
    TGChatID: tgChatId,
    TGEnabled: mergeBool(input.tgEnabled, cur.TGEnabled),
    Proxy: proxy,
    BarkProxy: mergeBool(input.barkProxy, cur.BarkProxy),
    FeishuProxy: mergeBool(input.feishuProxy, cur.FeishuProxy),
    TGProxy: mergeBool(input.tgProxy, cur.TGProxy),
  };
  writeChannelsRow(db, next);
  return getReminderChannels(db);
}

/** 明确清除一个渠道或代理的所有配置；删除后无法从页面恢复。 */
export function clearReminderChannel(db: Database.Database, name: "Bark" | "飞书" | "Telegram" | "代理"): ChannelConfig {
  return db.transaction(() => {
    const config = getReminderChannels(db);
    if (name === "Bark") {
      config.Bark = { URL: "", Key: "", Local: false };
      config.BarkEnabled = false;
      config.BarkProxy = false;
    } else if (name === "飞书") {
      config.FeishuWebhook = "";
      config.FeishuSecret = "";
      config.FeishuEnabled = false;
      config.FeishuProxy = false;
    } else if (name === "Telegram") {
      config.TGToken = "";
      config.TGChatID = "";
      config.TGEnabled = false;
      config.TGProxy = false;
    } else if (name === "代理") {
      config.Proxy = "";
      config.BarkProxy = false;
      config.FeishuProxy = false;
      config.TGProxy = false;
    } else {
      throw new Error("渠道无效");
    }
    writeChannelsRow(db, config);
    return config;
  }).immediate();
}

/** 渠道状态摘要（服务端用；不返回任何机密，Bark 仅主机名）。 */
export function summarizeChannels(config: ChannelConfig): ReminderChannelsSummary {
  let barkHost = "";
  if (config.Bark.URL.trim() !== "") {
    try {
      barkHost = new URL(config.Bark.URL.trim()).host;
    } catch {
      barkHost = "";
    }
  }
  return {
    bark: {
      enabled: config.BarkEnabled,
      local: config.Bark.Local,
      configured: config.Bark.URL.trim() !== "" && config.Bark.Key.trim() !== "",
      host: barkHost,
      useProxy: config.BarkProxy,
    },
    feishu: { enabled: config.FeishuEnabled, configured: config.FeishuWebhook.trim() !== "", useProxy: config.FeishuProxy },
    telegram: { enabled: config.TGEnabled, configured: config.TGToken.trim() !== "" && config.TGChatID.trim() !== "", useProxy: config.TGProxy },
    proxy: { configured: config.Proxy.trim() !== "" },
  };
}

/** 按证件夹数据库生成摘要；库异常时返回全「未启用/未配置」（页面不因读取失败而崩溃）。 */
export function summarizeReminderChannels(db: Database.Database): ReminderChannelsSummary {
  try {
    return summarizeChannels(getReminderChannels(db));
  } catch {
    return {
      bark: { enabled: false, local: false, configured: false, host: "", useProxy: false },
      feishu: { enabled: false, configured: false, useProxy: false },
      telegram: { enabled: false, configured: false, useProxy: false },
      proxy: { configured: false },
    };
  }
}

/** 推送路径的默认配置来源：只读证件夹库；读取失败返回 null（调用方按未配置跳过，永不抛错）。 */
export function loadReminderChannelConfig(db: Database.Database): ChannelConfig | null {
  try {
    return getReminderChannels(db);
  } catch {
    return null;
  }
}

export type StocksImportResult =
  | { ok: true; config: ChannelConfig }
  | { ok: false; error: string };

/**
 * 一次性显式导入：动态加载 stocks store 读取 notificationSettings，整行覆盖证件夹渠道配置
 * （含空值清空，真正的「覆盖」）。stocks 库缺失/损坏 → { ok:false }，不抛错、不改动现有配置。
 * 这是证件夹提醒代码里唯一接触 stocks 库的地方，且仅在用户显式点击导入时执行。
 */
export async function importChannelsFromStocks(db: Database.Database): Promise<StocksImportResult> {
  try {
    const { getDB, notificationSettings } = await import("@/modules/stocks/store");
    const stocksConfig = notificationSettings(getDB());
    if (!stocksConfig.Bark.URL && !stocksConfig.Bark.Key && !stocksConfig.FeishuWebhook && !stocksConfig.FeishuSecret && !stocksConfig.TGToken && !stocksConfig.TGChatID && !stocksConfig.Proxy) {
      return { ok: false, error: "行情设置没有可导入的通知配置，当前配置未更改" };
    }
    writeChannelsRow(db, stocksConfig);
    return { ok: true, config: getReminderChannels(db) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "无法读取行情通知配置" };
  }
}
