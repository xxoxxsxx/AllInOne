// 证件到期提醒渠道配置测试（documents.db 的 reminder_channels 表，独立于行情设置）：
// 默认值/持久化（含重开文件）、合并语义（留空保持）、stocks notify 校验（中文报错、失败不落库）、
// 摘要不含机密、从行情设置一次性导入（映射正确 + 覆盖清空 + 行情库不可用报错）。
// 不做任何真实网络推送。

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDocumentsDB } from "../src/lib/documents/db.ts";
import {
  clearReminderChannel,
  getReminderChannels,
  importChannelsFromStocks,
  loadReminderChannelConfig,
  saveReminderChannels,
  summarizeChannels,
  summarizeReminderChannels,
  type ReminderChannelsInput,
} from "../src/lib/documents/reminders-channels.ts";
import { openDB as openStocksDB, setDB as setStocksDB } from "../src/modules/stocks/store.ts";

function tempDb(): { db: ReturnType<typeof openDocumentsDB>; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-reminder-channels-"));
  const db = openDocumentsDB(root);
  return { db, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const EMPTY_CONFIG = {
  Bark: { URL: "", Key: "", Local: false },
  BarkEnabled: false,
  FeishuWebhook: "", FeishuSecret: "", FeishuEnabled: false,
  TGToken: "", TGChatID: "", TGEnabled: false,
  Proxy: "", BarkProxy: false, FeishuProxy: false, TGProxy: false,
};

test("reminder channels default to all-off, persist to disk, and stamp updated_at", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-reminder-channels-file-"));
  const file = path.join(root, "documents.db");
  try {
    const db = openDocumentsDB(undefined, file);
    assert.deepEqual(getReminderChannels(db), EMPTY_CONFIG);

    const saved = saveReminderChannels(db, {
      barkEnabled: true,
      barkUrl: "https://api.day.app",
      barkKey: "key-1",
      feishuEnabled: true,
      feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345",
      tgEnabled: true,
      tgToken: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tgChatId: "987654321",
      proxyUrl: "http://192.168.1.10:7890",
      barkProxy: true,
    });
    assert.equal(saved.Bark.URL, "https://api.day.app");
    assert.equal(saved.Bark.Key, "key-1");
    assert.ok(saved.FeishuEnabled);
    assert.equal(saved.Proxy, "http://192.168.1.10:7890");
    assert.ok(saved.BarkProxy);
    const at = (db.prepare(`SELECT updated_at FROM reminder_channels WHERE id=1`).get() as { updated_at: string }).updated_at;
    assert.match(at, /^\d{4}-\d{2}-\d{2}T/);
    db.close();

    // 重新打开文件：渠道配置持久化（跨重启有效）。
    const reopened = openDocumentsDB(undefined, file);
    const config = getReminderChannels(reopened);
    assert.equal(config.Bark.Key, "key-1");
    assert.equal(config.TGChatID, "987654321");
    assert.equal(config.FeishuWebhook, "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345");
    assert.equal(config.FeishuSecret, "");
    assert.equal(loadReminderChannelConfig(reopened)?.Bark.Key, "key-1");
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("merge semantics: blank/undefined text keeps existing values; booleans apply as submitted", () => {
  const { db, cleanup } = tempDb();
  try {
    saveReminderChannels(db, {
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

    // 只改开关与 Bark URL，其余文本留空 → 保持现有值（机密不回传客户端，客户端留空即「不修改」）。
    const merged = saveReminderChannels(db, {
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
    assert.equal(merged.Bark.URL, "https://api.day.app"); // checkBarkURL 规范化去掉尾部斜杠
    assert.equal(merged.Bark.Key, "secret-key");
    assert.equal(merged.Bark.Local, true);
    assert.equal(merged.FeishuWebhook, "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345");
    assert.equal(merged.FeishuSecret, "feishu-secret");
    assert.equal(merged.TGToken, "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(merged.TGChatID, "42");
    assert.equal(merged.Proxy, "http://10.0.0.2:7890");
    assert.equal(merged.BarkEnabled, false);
    assert.equal(merged.FeishuEnabled, false);
    assert.equal(merged.TGEnabled, true); // 未提交的开关保持
    assert.equal(merged.TGProxy, false);
    assert.equal(merged.BarkProxy, false); // 首次保存未提交 barkProxy，保持初值 false

    // undefined 等价于留空。
    const same = saveReminderChannels(db, {} as ReminderChannelsInput);
    assert.deepEqual(same, merged);
  } finally {
    db.close();
    cleanup();
  }
});

test("validation rejects invalid values with stocks' Chinese errors and leaves config unchanged", () => {
  const { db, cleanup } = tempDb();
  try {
    saveReminderChannels(db, {
      barkUrl: "https://api.day.app",
      barkKey: "good-key",
      feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345",
    });
    const before = getReminderChannels(db);

    const bad: Array<[ReminderChannelsInput, RegExp]> = [
      [{ barkUrl: "not-a-url" }, /Bark 地址须为 HTTPS/],
      [{ barkUrl: "http://192.168.1.5/push" }, /Bark 地址须为 HTTPS/], // http+内网但未开 barkLocal
      [{ barkUrl: "https://api.day.app/push" }, /Bark 地址须为 HTTPS/], // 带路径
      [{ feishuWebhook: "https://example.com/hook/x" }, /飞书 Webhook/],
      [{ tgToken: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", tgChatId: "" }, /同时填写/],
      [{ tgToken: "", tgChatId: "42" }, /同时填写/],
      [{ tgToken: "short", tgChatId: "42" }, /Telegram Bot Token 或数字 Chat ID 格式无效/],
      [{ proxyUrl: "ftp://x" }, /代理地址须为/],
    ];
    for (const [input, re] of bad) {
      assert.throws(() => saveReminderChannels(db, input), re, JSON.stringify(input));
    }
    // 校验失败不落库：配置保持原样。
    assert.deepEqual(getReminderChannels(db), before);

    // 合法：内网 http 在显式允许后可用（合并语义下带 barkLocal 开关一起提交）。
    const local = saveReminderChannels(db, { barkUrl: "http://192.168.1.5", barkLocal: true });
    assert.equal(local.Bark.URL, "http://192.168.1.5");
    assert.ok(local.Bark.Local);
  } finally {
    db.close();
    cleanup();
  }
});

test("summaries expose booleans and Bark host only, never secrets", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.deepEqual(summarizeReminderChannels(db), {
      bark: { enabled: false, local: false, configured: false, host: "", useProxy: false },
      feishu: { enabled: false, configured: false, useProxy: false },
      telegram: { enabled: false, configured: false, useProxy: false },
      proxy: { configured: false },
    });

    saveReminderChannels(db, {
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
    const summary = summarizeReminderChannels(db);
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

    // 非法 Bark 地址：host 降级为空串，configured 按「非空即已配置」判断（校验在保存时把关）。
    db.exec(`UPDATE reminder_channels SET bark_url='not a url' WHERE id=1`);
    assert.equal(summarizeReminderChannels(db).bark.host, "");
    assert.equal(summarizeReminderChannels(db).bark.configured, true);

    // 表损坏时摘要不抛错：全「未启用/未配置」。
    const { db: broken, cleanup: brokenCleanup } = tempDb();
    try {
      broken.exec("CREATE TABLE reminder_channels (id INTEGER PRIMARY KEY)");
      assert.deepEqual(summarizeReminderChannels(broken).bark, { enabled: false, local: false, configured: false, host: "", useProxy: false });
    } finally {
      broken.close();
      brokenCleanup();
    }
  } finally {
    db.close();
    cleanup();
  }
});

test("importChannelsFromStocks maps stocks fields and fully overwrites documents config", async () => {
  const { db, cleanup } = tempDb();
  const stocks = openStocksDB(undefined, ":memory:");
  try {
    // 预置一份 stocks 渠道配置。
    stocks
      .prepare(
        `UPDATE settings SET bark_url=?,bark_key=?,bark_local=1,bark_enabled=1,
         feishu_webhook=?,feishu_secret=?,feishu_enabled=1,
         tg_token=?,tg_chat_id=?,tg_enabled=1,
         proxy_url=?,bark_proxy=1,feishu_proxy=0,tg_proxy=1 WHERE id=1`,
      )
      .run(
        "https://api.day.app",
        "stocks-key",
        "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345",
        "feishu-secret",
        "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "987654321",
        "socks5://10.0.0.3:1080",
      );
    setStocksDB(stocks);

    // 证件夹侧先有一份不同配置 → 导入应整行覆盖。
    saveReminderChannels(db, { barkUrl: "https://old.example.com", barkKey: "old-key" });
    const result = await importChannelsFromStocks(db);
    assert.ok(result.ok);
    const config = getReminderChannels(db);
    assert.deepEqual(config, {
      Bark: { URL: "https://api.day.app", Key: "stocks-key", Local: true },
      BarkEnabled: true,
      FeishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345",
      FeishuSecret: "feishu-secret",
      FeishuEnabled: true,
      TGToken: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      TGChatID: "987654321",
      TGEnabled: true,
      Proxy: "socks5://10.0.0.3:1080",
      BarkProxy: true,
      FeishuProxy: false,
      TGProxy: true,
    });
    // 导入结果与读取一致（映射逐字段正确）。
    assert.deepEqual((result as { ok: true; config: typeof config }).config, config);

    // 覆盖含清空：stocks 配置清空后再次导入 → 证件夹侧同步清空（这是整行覆盖，不是合并）。
    stocks.prepare(`UPDATE settings SET bark_url='',bark_key='',bark_enabled=0 WHERE id=1`).run();
    const second = await importChannelsFromStocks(db);
    assert.ok(second.ok);
    const cleared = getReminderChannels(db);
    assert.equal(cleared.Bark.URL, "");
    assert.equal(cleared.Bark.Key, "");
    assert.equal(cleared.BarkEnabled, false);
    // 其余字段仍来自 stocks。
    assert.equal(cleared.TGChatID, "987654321");
  } finally {
    setStocksDB(null);
    stocks.close();
    db.close();
    cleanup();
  }
});

test("clear channel removes its secrets without changing other channels", () => {
  const { db, cleanup } = tempDb();
  try {
    saveReminderChannels(db, {
      barkUrl: "https://api.day.app", barkKey: "key", barkEnabled: true,
      feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345", feishuEnabled: true,
      proxyUrl: "http://10.0.0.2:7890", barkProxy: true, feishuProxy: true,
    });
    clearReminderChannel(db, "Bark");
    const after = getReminderChannels(db);
    assert.deepEqual(after.Bark, { URL: "", Key: "", Local: false });
    assert.equal(after.BarkEnabled, false);
    assert.equal(after.BarkProxy, false);
    assert.equal(after.FeishuEnabled, true);
    assert.equal(after.FeishuProxy, true);
    clearReminderChannel(db, "代理");
    assert.equal(getReminderChannels(db).Proxy, "");
    assert.equal(getReminderChannels(db).FeishuProxy, false);
  } finally {
    db.close();
    cleanup();
  }
});

test("empty stocks settings do not overwrite configured documents channels", async () => {
  const { db, cleanup } = tempDb();
  const stocks = openStocksDB(undefined, ":memory:");
  try {
    saveReminderChannels(db, { barkUrl: "https://keep.example.com", barkKey: "keep-key", barkEnabled: true });
    const before = getReminderChannels(db);
    setStocksDB(stocks);
    const result = await importChannelsFromStocks(db);
    assert.equal(result.ok, false);
    assert.deepEqual(getReminderChannels(db), before);
  } finally {
    setStocksDB(null);
    stocks.close();
    db.close();
    cleanup();
  }
});

test("importChannelsFromStocks reports ok:false when the stocks db is unreadable", async () => {
  const { db, cleanup } = tempDb();
  const broken = new Database(":memory:"); // 无 settings 表 → notificationSettings 抛错
  try {
    // 证件夹侧先保存配置：导入失败必须保持原样。
    saveReminderChannels(db, { barkUrl: "https://keep.example.com", barkKey: "keep-key", barkEnabled: true });

    setStocksDB(broken as unknown as Parameters<typeof setStocksDB>[0]);
    const result = await importChannelsFromStocks(db);
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; error: string }).error, /no such table|无法读取/);
    // 失败不改动现有配置。
    const config = getReminderChannels(db);
    assert.equal(config.Bark.URL, "https://keep.example.com");
    assert.equal(config.Bark.Key, "keep-key");
    assert.ok(config.BarkEnabled);
  } finally {
    setStocksDB(null);
    broken.close();
    db.close();
    cleanup();
  }
});
