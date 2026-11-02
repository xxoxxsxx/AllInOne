// 全局推送渠道中心：Bark / 飞书群机器人 / Telegram Bot + 共享代理的统一配置存储。
// 所有业务模块（证件夹到期提醒、独立提醒模块等）都通过本中心读写渠道配置，
// 不再各自在业务库里建表。配置持久化在 DATA_DIR/channels/channels.db 的 channels 表
// （单行 id=1，列与旧版证件夹 reminder_channels 完全一致：同列名/同默认值），
// WAL 模式，CREATE TABLE IF NOT EXISTS 惰性建表。
//
// 复用的外部逻辑只有 stocks notify 的纯校验函数（checkBarkURL/checkFeishuWebhook/
// checkTG/checkProxy，中文报错）与 ChannelConfig 类型（形状与 stocks 一致）；
// 本文件不依赖任何业务模块（documents/travel/stocks store）。
//
// 保存采用「合并语义」：文本字段（URL/Key/Webhook/Secret/Token/ChatID/代理）缺省或留空
// 表示「保持现有值」（设置页展示现有配置，仅提交非空的修改）；开关类布尔字段总是按提交值应用。
// 非空值经 stocks notify 的 check* 校验（中文报错），校验失败不落库。
//
// 一次性迁移（copy-if-empty）：getChannelConfig() 发现 channels 行全空时，按顺序从
// ① DATA_DIR/documents/documents.db 的 reminder_channels 表（原证件夹提醒渠道）
// ② DATA_DIR/tickersentry/ticker.db 的 settings 表（原 TickerSentry 通知渠道）
// 把首个非空配置复制进中心。语义要点：
// - 只读旧库（readonly 打开、只 SELECT），绝不写/删它们的表，旧行随旧代码退役自然闲置；
// - 幂等：中心一旦有配置就不再迁移（旧库行保持陈旧也不会把新配置冲掉）；
// - 换回旧备份（旧库非空、中心为空）能再次播种中心；
// - 旧库不存在/无表/损坏 → 静默跳过迁移，中心照常返回（全空）配置。

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/data-dir";
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

// —— 连接管理：进程内单例（globalThis，dev 热重载/多实例共存也安全） ——

declare global {
  var __channelsSqlite: Database.Database | undefined;
}

/** 中心库文件路径：DATA_DIR/channels/channels.db。 */
export function channelsDbPath(): string {
  return path.join(dataDir(), "channels", "channels.db");
}

/**
 * 中心库单例连接：目录不存在则 mkdir -p，WAL 模式，
 * 并惰性建 channels 表（列/默认值与旧版 documents reminder_channels 完全一致，单行 id=1）。
 */
export function getChannelsDb(): Database.Database {
  if (globalThis.__channelsSqlite) return globalThis.__channelsSqlite;
  const file = channelsDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
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
      INSERT OR IGNORE INTO channels(id) VALUES(1);
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  globalThis.__channelsSqlite = db;
  return db;
}

/** 仅供测试：关闭并清空单例，使下一次 getChannelsDb() 重新按当前 DATA_DIR 打开。 */
export function closeChannelsDbForTest(): void {
  const db = globalThis.__channelsSqlite;
  if (db) {
    try {
      db.close();
    } catch {
      // 已损坏/已关闭的连接忽略即可。
    }
  }
  globalThis.__channelsSqlite = undefined;
}

// —— 行读写 ——

type ChannelsRow = {
  bark_url: string; bark_key: string; bark_local: number; bark_enabled: number;
  feishu_webhook: string; feishu_secret: string; feishu_enabled: number;
  tg_token: string; tg_chat_id: string; tg_enabled: number;
  proxy_url: string; bark_proxy: number; feishu_proxy: number; tg_proxy: number;
};

function rowToConfig(r: ChannelsRow): ChannelConfig {
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

export const EMPTY_CHANNEL_CONFIG: ChannelConfig = {
  Bark: { URL: "", Key: "", Local: false },
  BarkEnabled: false,
  FeishuWebhook: "", FeishuSecret: "", FeishuEnabled: false,
  TGToken: "", TGChatID: "", TGEnabled: false,
  Proxy: "", BarkProxy: false, FeishuProxy: false, TGProxy: false,
};

function isEmptyChannelConfig(c: ChannelConfig): boolean {
  return (
    c.Bark.URL === "" && c.Bark.Key === "" && !c.Bark.Local && !c.BarkEnabled &&
    c.FeishuWebhook === "" && c.FeishuSecret === "" && !c.FeishuEnabled &&
    c.TGToken === "" && c.TGChatID === "" && !c.TGEnabled &&
    c.Proxy === "" && !c.BarkProxy && !c.FeishuProxy && !c.TGProxy
  );
}

const CHANNELS_SELECT = `
  SELECT bark_url,bark_key,bark_local,bark_enabled,
         feishu_webhook,feishu_secret,feishu_enabled,
         tg_token,tg_chat_id,tg_enabled,
         proxy_url,bark_proxy,feishu_proxy,tg_proxy
  FROM channels WHERE id=1`;

function readChannelsRow(db: Database.Database): ChannelConfig {
  const r = db.prepare(CHANNELS_SELECT).get() as ChannelsRow | undefined;
  return r ? rowToConfig(r) : { ...EMPTY_CHANNEL_CONFIG, Bark: { ...EMPTY_CHANNEL_CONFIG.Bark } };
}

/** 整行写入（导入/迁移/清除用：含空值，真正「覆盖」）；调用方自行保证值合法。 */
export function writeChannelConfig(config: ChannelConfig): void {
  const db = getChannelsDb();
  db.prepare(
    `INSERT INTO channels(
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

// —— 旧库的一次性迁移（copy-if-empty，只读）：证件夹 reminder_channels → 行情 settings → 中心 ——

function readLegacyChannelsFrom(file: string, table: string): ChannelConfig | null {
  if (!fs.existsSync(file)) return null; // 绝不因迁移而创建旧库
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const r = db.prepare(
      `SELECT bark_url,bark_key,bark_local,bark_enabled,
              feishu_webhook,feishu_secret,feishu_enabled,
              tg_token,tg_chat_id,tg_enabled,
              proxy_url,bark_proxy,feishu_proxy,tg_proxy
       FROM ${table} WHERE id=1`,
    ).get() as ChannelsRow | undefined;
    return r ? rowToConfig(r) : null;
  } catch {
    return null; // 无表/表结构不全/库损坏：跳过迁移，中心照常工作
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}

function readLegacyDocumentsChannels(): ChannelConfig | null {
  return readLegacyChannelsFrom(path.join(dataDir(), "documents", "documents.db"), "reminder_channels");
}

function readLegacyStocksChannels(): ChannelConfig | null {
  return readLegacyChannelsFrom(path.join(dataDir(), "tickersentry", "ticker.db"), "settings");
}

function migrateFromLegacyIfEmpty(): void {
  const current = readChannelsRow(getChannelsDb());
  if (!isEmptyChannelConfig(current)) return; // 中心已有配置：永不再次迁移
  // 迁移顺序：证件夹（原提醒渠道配置）优先，其次行情（TickerSentry 通知设置）。
  for (const legacy of [readLegacyDocumentsChannels(), readLegacyStocksChannels()]) {
    if (legacy && !isEmptyChannelConfig(legacy)) {
      writeChannelConfig(legacy);
      return;
    }
  }
}

// —— 公共 API ——

/**
 * 读取渠道配置；中心为空时按顺序执行一次性 copy-if-empty 迁移：
 * 证件夹库（reminder_channels）→ 行情库（settings 表）。表结构损坏时抛错
 * （摘要/推送路径各自降级处理）。
 */
export function getChannelConfig(): ChannelConfig {
  try {
    migrateFromLegacyIfEmpty();
  } catch {
    // 迁移失败绝不影响正常读取。
  }
  return readChannelsRow(getChannelsDb());
}

/** 文本合并：undefined / 留空 → 保持现有值。 */
function mergeText(value: string | undefined | null, current: string): string {
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
export function saveChannelConfig(input: ReminderChannelsInput): ChannelConfig {
  const cur = getChannelConfig();
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
  writeChannelConfig(next);
  return getChannelConfig();
}

/** 渠道状态摘要（不返回任何机密，Bark 仅主机名）。 */
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

/** 按中心库生成摘要；库异常时返回全「未启用/未配置」（页面不因读取失败而崩溃）。 */
export function summarizeChannelConfig(): ReminderChannelsSummary {
  try {
    return summarizeChannels(getChannelConfig());
  } catch {
    return {
      bark: { enabled: false, local: false, configured: false, host: "", useProxy: false },
      feishu: { enabled: false, configured: false, useProxy: false },
      telegram: { enabled: false, configured: false, useProxy: false },
      proxy: { configured: false },
    };
  }
}

/** 推送路径的默认配置来源：只读中心库；读取失败返回 null（调用方按未配置跳过，永不抛错）。 */
export function loadChannelConfig(): ChannelConfig | null {
  try {
    return getChannelConfig();
  } catch {
    return null;
  }
}

/** 明确清除一个渠道或代理的所有配置；删除后无法从页面恢复。 */
export function clearGlobalChannel(name: "Bark" | "飞书" | "Telegram" | "代理"): ChannelConfig {
  return getChannelsDb().transaction(() => {
    const config = getChannelConfig();
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
    writeChannelConfig(config);
    return config;
  }).immediate();
}
