// 全局推送渠道中心（src/lib/channels/center.ts）回归测试：
// - 合并语义（文本留空/缺省保持现有值；布尔按提交值应用）与空输入不变更；
// - 摘要绝不含机密（Bark 仅主机名）；
// - 旧版 documents.db reminder_channels 的一次性 copy-if-empty 迁移：
//   旧库有配置 → 首次读取播种中心；中心保存新值后不再次迁移；
//   旧库为空/无表/缺失 → 跳过且绝不创建 documents.db（只读，永不写旧库）；
// - 「从行情设置导入」（importChannelsFromStocks）改写中心库。
// 隔离方式与 documents-backup.test.ts 相同：独立临时 DATA_DIR + 重置中心单例。
// 不做任何真实网络推送。

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  channelsDbPath,
  closeChannelsDbForTest,
  getChannelConfig,
  getChannelsDb,
  saveChannelConfig,
  summarizeChannelConfig,
  summarizeChannels,
  writeChannelConfig,
  type ReminderChannelsInput,
} from "../src/lib/channels/center.ts";
import { openDB as openStocksDB, setDB as setStocksDB } from "../src/modules/stocks/store.ts";

const EMPTY_CONFIG = {
  Bark: { URL: "", Key: "", Local: false },
  BarkEnabled: false,
  FeishuWebhook: "", FeishuSecret: "", FeishuEnabled: false,
  TGToken: "", TGChatID: "", TGEnabled: false,
  Proxy: "", BarkProxy: false, FeishuProxy: false, TGProxy: false,
};

/** 独立临时 DATA_DIR + 重置中心单例；返回 DATA_DIR 根与旧版 documents.db 文件路径。 */
async function withChannelCenterEnv(
  run: (env: { root: string; legacyDbFile: string }) => void | Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channels-center-"));
  const previous = process.env.DATA_DIR;
  closeChannelsDbForTest();
  process.env.DATA_DIR = root;
  try {
    await run({ root, legacyDbFile: path.join(root, "documents", "documents.db") });
  } finally {
    closeChannelsDbForTest();
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("channels-center-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 旧版 DDL（与迁移前的 documents reminder_channels 完全一致），用于播种旧库 fixture。 */
const LEGACY_DDL = `
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
`;

/** 造一个带 reminder_channels 行的旧版 documents.db（等价于旧版备份文件）。 */
function seedLegacyDocumentsDb(file: string, row: Partial<Record<string, string | number>>): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(LEGACY_DDL);
  const sets = Object.keys(row).map((k) => `${k}=?`).join(",");
  if (sets) db.prepare(`UPDATE reminder_channels SET ${sets} WHERE id=1`).run(...Object.values(row));
  return db;
}

test("merge semantics: blank/undefined text keeps existing values; booleans apply as submitted", async () => {
    await withChannelCenterEnv(() => {
    saveChannelConfig({
      barkEnabled: true,
      barkUrl: "https://api.day.app",
      barkKey: "secret-key",
      barkLocal: true,
      feishuEnabled: true,
      feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345",
      feishuSecret: "feishu-secret",
      tgEnabled: true,
      tgToken: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tgChatId: "42",
      proxyUrl: "http://10.0.0.2:7890",
      tgProxy: true,
    });

    // 只改开关与 Bark URL，其余文本留空 → 保持现有值。
    const merged = saveChannelConfig({
      barkEnabled: false,
      barkUrl: "https://api.day.app/",
      feishuEnabled: false,
      tgProxy: false,
      barkKey: "",
      feishuSecret: "",
      tgToken: "",
      tgChatId: "",
      proxyUrl: "",
    });
    assert.equal(merged.Bark.URL, "https://api.day.app");
    assert.equal(merged.Bark.Key, "secret-key");
    assert.equal(merged.Bark.Local, true);
    assert.equal(merged.FeishuWebhook, "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345");
    assert.equal(merged.FeishuSecret, "feishu-secret");
    assert.equal(merged.TGToken, "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(merged.TGChatID, "42");
    assert.equal(merged.Proxy, "http://10.0.0.2:7890");
    assert.equal(merged.BarkEnabled, false);
    assert.equal(merged.FeishuEnabled, false);
    assert.equal(merged.TGEnabled, true);
    assert.equal(merged.TGProxy, false);
    assert.equal(merged.BarkProxy, false);

    // 空输入 = 完全不变更；且确实落库（channels.db 单行）。
    const same = saveChannelConfig({} as ReminderChannelsInput);
    assert.deepEqual(same, merged);
    const count = (getChannelsDb().prepare(`SELECT COUNT(*) AS n FROM channels`).get() as { n: number }).n;
    assert.equal(count, 1);
  });
});

test("summaries expose booleans and Bark host only, never secrets", async () => {
    await withChannelCenterEnv(() => {
    assert.deepEqual(summarizeChannelConfig(), {
      bark: { enabled: false, local: false, configured: false, host: "", useProxy: false },
      feishu: { enabled: false, configured: false, useProxy: false },
      telegram: { enabled: false, configured: false, useProxy: false },
      proxy: { configured: false },
    });

    saveChannelConfig({
      barkEnabled: true,
      barkUrl: "https://api.day.app",
      barkKey: "SECRET-KEY",
      feishuEnabled: true,
      feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/SECRETHOOK00001",
      tgEnabled: false,
      tgToken: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tgChatId: "42",
      proxyUrl: "http://10.0.0.2:7890",
      barkProxy: true,
      feishuProxy: true,
      tgProxy: true,
    });
    const summary = summarizeChannelConfig();
    assert.deepEqual(summary, {
      bark: { enabled: true, local: false, configured: true, host: "api.day.app", useProxy: true },
      feishu: { enabled: true, configured: true, useProxy: true },
      telegram: { enabled: false, configured: true, useProxy: true },
      proxy: { configured: true },
    });
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes("SECRET"));
    assert.ok(!serialized.includes("https://"));
    assert.ok(!serialized.includes("10.0.0.2"));
    // summarizeChannels(config) 与 summarizeChannelConfig() 对同一配置结果一致。
    assert.deepEqual(summarizeChannels(getChannelConfig()), summary);
  });
});

test("migration copies a configured legacy documents row into an empty center, then never re-migrates", async () => {
    await withChannelCenterEnv(({ legacyDbFile }) => {
    const legacy = seedLegacyDocumentsDb(legacyDbFile, {
      bark_url: "https://api.day.app",
      bark_key: "legacy-key",
      bark_enabled: 1,
      feishu_webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345",
      feishu_enabled: 1,
      tg_token: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tg_chat_id: "987654321",
      tg_enabled: 1,
      proxy_url: "socks5://10.0.0.3:1080",
      tg_proxy: 1,
      updated_at: "2020-01-01T00:00:00.000Z",
    });

    // 首次读取：旧库非空 + 中心为空 → copy-if-empty 播种。
    assert.deepEqual(getChannelConfig(), {
      Bark: { URL: "https://api.day.app", Key: "legacy-key", Local: false },
      BarkEnabled: true,
      FeishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345",
      FeishuSecret: "",
      FeishuEnabled: true,
      TGToken: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      TGChatID: "987654321",
      TGEnabled: true,
      Proxy: "socks5://10.0.0.3:1080",
      BarkProxy: false,
      FeishuProxy: false,
      TGProxy: true,
    });

    // 中心保存新值后：即使旧行还是旧值，也不再迁移（幂等）。
    const updated = saveChannelConfig({ barkUrl: "https://new.example.com", barkKey: "new-key" });
    assert.equal(updated.Bark.URL, "https://new.example.com");
    assert.equal(updated.Bark.Key, "new-key");
    assert.equal(getChannelConfig().Bark.URL, "https://new.example.com");
    assert.equal(getChannelConfig().Bark.Key, "new-key");

    // 旧库保持原样（只读迁移，绝不写/删 documents 的表）。
    const legacyRow = legacy.prepare(`SELECT bark_url,bark_key,updated_at FROM reminder_channels WHERE id=1`).get() as {
      bark_url: string;
      bark_key: string;
      updated_at: string;
    };
    assert.equal(legacyRow.bark_url, "https://api.day.app");
    assert.equal(legacyRow.bark_key, "legacy-key");
    assert.equal(legacyRow.updated_at, "2020-01-01T00:00:00.000Z");
    legacy.close();
  });
});

test("migration is skipped when the center is already configured", async () => {
    await withChannelCenterEnv(({ legacyDbFile }) => {
    seedLegacyDocumentsDb(legacyDbFile, {
      bark_url: "https://legacy.example.com",
      bark_key: "legacy-key",
      bark_enabled: 1,
    });

    // 中心先有自己的配置 → 旧库不会被读取/迁移。
    saveChannelConfig({ barkUrl: "https://center.example.com", barkKey: "center-key" });
    const config = getChannelConfig();
    assert.equal(config.Bark.URL, "https://center.example.com");
    assert.equal(config.Bark.Key, "center-key");
  });
});

test("migration is skipped for a missing / empty / tableless legacy db and never creates documents.db", async () => {
    await withChannelCenterEnv(({ root, legacyDbFile }) => {
    // 1) documents.db 不存在：读取返回全空，且绝不创建 documents 目录/文件。
    assert.deepEqual(getChannelConfig(), EMPTY_CONFIG);
    assert.ok(!fs.existsSync(path.join(root, "documents")));

    // 2) 旧库存在但 reminder_channels 行全空：无可迁移内容。
    const emptyLegacy = seedLegacyDocumentsDb(legacyDbFile, {});
    assert.deepEqual(getChannelConfig(), EMPTY_CONFIG);
    emptyLegacy.close();
    closeChannelsDbForTest();
    fs.rmSync(legacyDbFile, { force: true });
    fs.rmSync(path.join(root, "documents"), { recursive: true, force: true });

    // 3) 旧库存在但没有 reminder_channels 表：SELECT 失败 → 静默跳过。
    fs.mkdirSync(path.dirname(legacyDbFile), { recursive: true });
    const tableless = new Database(legacyDbFile);
    tableless.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY)");
    tableless.close();
    assert.deepEqual(getChannelConfig(), EMPTY_CONFIG);
    assert.equal(summarizeChannelConfig().bark.configured, false);

    // 中心库本身照常创建。
    assert.ok(fs.existsSync(channelsDbPath()));
  });
});

test("writeChannelConfig overwrites the full row including empty values", async () => {
    await withChannelCenterEnv(() => {
    saveChannelConfig({
      barkUrl: "https://api.day.app",
      barkKey: "key",
      barkEnabled: true,
      proxyUrl: "http://10.0.0.2:7890",
      barkProxy: true,
    });
    writeChannelConfig(EMPTY_CONFIG);
    assert.deepEqual(getChannelConfig(), EMPTY_CONFIG);
  });
});

test("center migrates stocks ticker.db channels when documents has none", async () => {
  await withChannelCenterEnv(async ({ root }) => {
    // 行情库带一份 TickerSentry 通知渠道配置（原 settings 表）。
    const stocksFile = path.join(root, "tickersentry", "ticker.db");
    fs.mkdirSync(path.dirname(stocksFile), { recursive: true });
    const stocks = new Database(stocksFile);
    stocks.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        bark_url TEXT NOT NULL DEFAULT '', bark_key TEXT NOT NULL DEFAULT '',
        bark_local INTEGER NOT NULL DEFAULT 0, bark_enabled INTEGER NOT NULL DEFAULT 0,
        feishu_webhook TEXT NOT NULL DEFAULT '', feishu_secret TEXT NOT NULL DEFAULT '',
        feishu_enabled INTEGER NOT NULL DEFAULT 0,
        tg_token TEXT NOT NULL DEFAULT '', tg_chat_id TEXT NOT NULL DEFAULT '',
        tg_enabled INTEGER NOT NULL DEFAULT 0,
        proxy_url TEXT NOT NULL DEFAULT '',
        bark_proxy INTEGER NOT NULL DEFAULT 0, feishu_proxy INTEGER NOT NULL DEFAULT 0,
        tg_proxy INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO settings(id) VALUES(1);
    `);
    stocks.prepare(`UPDATE settings SET bark_url='https://api.day.app',bark_key='stocks-key',bark_enabled=1,proxy_url='http://10.0.0.9:7890',tg_proxy=1 WHERE id=1`).run();
    stocks.close();

    assert.deepEqual(getChannelConfig(), {
      Bark: { URL: "https://api.day.app", Key: "stocks-key", Local: false },
      BarkEnabled: true,
      FeishuWebhook: "", FeishuSecret: "", FeishuEnabled: false,
      TGToken: "", TGChatID: "", TGEnabled: false,
      Proxy: "http://10.0.0.9:7890", BarkProxy: false, FeishuProxy: false, TGProxy: true,
    }, "stocks channels seed the center when it is empty");

    // 迁移只读：行情库的行原样保留（只断言字段不被改动）。
    const reopened = new Database(stocksFile, { readonly: true });
    const row = reopened.prepare(`SELECT bark_url,bark_key,bark_enabled FROM settings WHERE id=1`).get() as { bark_url: string; bark_key: string; bark_enabled: number };
    reopened.close();
    assert.equal(row.bark_url, "https://api.day.app");
    assert.equal(row.bark_key, "stocks-key");
    assert.equal(row.bark_enabled, 1);
  });
});

test("documents channels take precedence over stocks when both legacy dbs have config", async () => {
  await withChannelCenterEnv(async ({ root, legacyDbFile }) => {
    // 行情库与证件夹库各有一份配置：同一次迁移决策中证件夹优先。
    const stocksFile = path.join(root, "tickersentry", "ticker.db");
    fs.mkdirSync(path.dirname(stocksFile), { recursive: true });
    const stocks = new Database(stocksFile);
    stocks.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        bark_url TEXT NOT NULL DEFAULT '', bark_key TEXT NOT NULL DEFAULT '',
        bark_local INTEGER NOT NULL DEFAULT 0, bark_enabled INTEGER NOT NULL DEFAULT 0,
        feishu_webhook TEXT NOT NULL DEFAULT '', feishu_secret TEXT NOT NULL DEFAULT '',
        feishu_enabled INTEGER NOT NULL DEFAULT 0,
        tg_token TEXT NOT NULL DEFAULT '', tg_chat_id TEXT NOT NULL DEFAULT '',
        tg_enabled INTEGER NOT NULL DEFAULT 0,
        proxy_url TEXT NOT NULL DEFAULT '',
        bark_proxy INTEGER NOT NULL DEFAULT 0, feishu_proxy INTEGER NOT NULL DEFAULT 0,
        tg_proxy INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO settings(id) VALUES(1);
    `);
    stocks.prepare(`UPDATE settings SET bark_url='https://api.day.app',bark_key='stocks-key',bark_enabled=1 WHERE id=1`).run();
    stocks.close();

    const legacy = seedLegacyDocumentsDb(legacyDbFile, { bark_url: "https://docs.example.com", bark_key: "docs-key", bark_enabled: 1 });

    assert.equal(getChannelConfig().Bark.Key, "docs-key", "documents wins the first migration pass");
    // 行情库不被触碰。
    const reopened = new Database(stocksFile, { readonly: true });
    const row = reopened.prepare(`SELECT bark_key FROM settings WHERE id=1`).get() as { bark_key: string };
    reopened.close();
    assert.equal(row.bark_key, "stocks-key");
  });
});
