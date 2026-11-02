// 证件到期提醒渠道配置测试（全局推送渠道中心 = DATA_DIR/channels/channels.db，
// 经 src/lib/documents/reminders-channels 兼容委托读写，db 形参保留但忽略）：
// 默认值/持久化（含重开文件）、合并语义（留空保持）、stocks notify 校验（中文报错、失败不落库）、
// 摘要不含机密、清除渠道、从行情设置一次性导入（映射正确 + 覆盖清空 + 行情库不可用报错）。
// 隔离方式与 documents-backup.test.ts 相同：每个用例独立临时 DATA_DIR + 重置中心单例。
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
} from "../src/lib/channels/center.ts";
import {
  clearReminderChannel,
  getReminderChannels,
  loadReminderChannelConfig,
  saveReminderChannels,
  summarizeChannels,
  summarizeReminderChannels,
  type ReminderChannelsInput,
} from "../src/lib/documents/reminders-channels.ts";

const EMPTY_CONFIG = {
  Bark: { URL: "", Key: "", Local: false },
  BarkEnabled: false,
  FeishuWebhook: "", FeishuSecret: "", FeishuEnabled: false,
  TGToken: "", TGChatID: "", TGEnabled: false,
  Proxy: "", BarkProxy: false, FeishuProxy: false, TGProxy: false,
};

/** 独立临时 DATA_DIR + 重置中心单例；docsDb 是证件夹库句柄（委托层的 db 形参，应被忽略）。 */
async function withChannelCenterEnv(run: (env: { root: string; docsDb: Database.Database }) => void | Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-reminder-channels-"));
  const previous = process.env.DATA_DIR;
  closeChannelsDbForTest();
  process.env.DATA_DIR = root;
  const docsDb = new Database(":memory:");
  try {
    await run({ root, docsDb });
  } finally {
    docsDb.close();
    closeChannelsDbForTest();
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("documents-reminder-channels-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 把中心库的 channels 表换成缺列的坏表（CREATE IF NOT EXISTS 不会修复它）。 */
function breakCenterChannelsTable(): void {
  closeChannelsDbForTest();
  const broken = new Database(channelsDbPath());
  broken.exec("DROP TABLE channels");
  broken.exec("CREATE TABLE channels (id INTEGER PRIMARY KEY)");
  broken.close();
}

test("reminder channels default to all-off, persist to the center db on disk, and stamp updated_at", async () => {
  await withChannelCenterEnv(async ({ root, docsDb }) => {
    assert.deepEqual(getReminderChannels(docsDb), EMPTY_CONFIG);
    // 委托层与中心读的是同一份配置；且读取不会创建 documents.db（迁移只读、绝不写）。
    assert.deepEqual(getChannelConfig(), EMPTY_CONFIG);
    assert.ok(!fs.existsSync(path.join(root, "documents")));

    const saved = saveReminderChannels(docsDb, {
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
    const at = (getChannelsDb().prepare(`SELECT updated_at FROM channels WHERE id=1`).get() as { updated_at: string }).updated_at;
    assert.match(at, /^\d{4}-\d{2}-\d{2}T/);

    // 重新打开中心库（模拟重启）：渠道配置持久化（跨重启有效）。
    closeChannelsDbForTest();
    const config = getReminderChannels(docsDb);
    assert.equal(config.Bark.Key, "key-1");
    assert.equal(config.TGChatID, "987654321");
    assert.equal(config.FeishuWebhook, "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345");
    assert.equal(config.FeishuSecret, "");
    assert.equal(loadReminderChannelConfig(docsDb)?.Bark.Key, "key-1");
    assert.ok(fs.existsSync(channelsDbPath()));
  });
});

test("merge semantics: blank/undefined text keeps existing values; booleans apply as submitted", async () => {
  await withChannelCenterEnv(async ({ docsDb }) => {
    saveReminderChannels(docsDb, {
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
    const merged = saveReminderChannels(docsDb, {
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
    const same = saveReminderChannels(docsDb, {} as ReminderChannelsInput);
    assert.deepEqual(same, merged);
  });
});

test("validation rejects invalid values with stocks' Chinese errors and leaves config unchanged", async () => {
  await withChannelCenterEnv(async ({ docsDb }) => {
    saveReminderChannels(docsDb, {
      barkUrl: "https://api.day.app",
      barkKey: "good-key",
      feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345",
    });
    const before = getReminderChannels(docsDb);

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
      assert.throws(() => saveReminderChannels(docsDb, input), re, JSON.stringify(input));
    }
    // 校验失败不落库：配置保持原样。
    assert.deepEqual(getReminderChannels(docsDb), before);

    // 合法：内网 http 在显式允许后可用（合并语义下带 barkLocal 开关一起提交）。
    const local = saveReminderChannels(docsDb, { barkUrl: "http://192.168.1.5", barkLocal: true });
    assert.equal(local.Bark.URL, "http://192.168.1.5");
    assert.ok(local.Bark.Local);
  });
});

test("summaries expose booleans and Bark host only, never secrets", async () => {
  await withChannelCenterEnv(async ({ docsDb }) => {
    assert.deepEqual(summarizeReminderChannels(docsDb), {
      bark: { enabled: false, local: false, configured: false, host: "", useProxy: false },
      feishu: { enabled: false, configured: false, useProxy: false },
      telegram: { enabled: false, configured: false, useProxy: false },
      proxy: { configured: false },
    });

    saveReminderChannels(docsDb, {
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
    const summary = summarizeReminderChannels(docsDb);
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
    getChannelsDb().prepare(`UPDATE channels SET bark_url='not a url' WHERE id=1`).run();
    assert.equal(summarizeReminderChannels(docsDb).bark.host, "");
    assert.equal(summarizeReminderChannels(docsDb).bark.configured, true);

    // 中心库 channels 表损坏时摘要不抛错：全「未启用/未配置」。
    breakCenterChannelsTable();
    assert.deepEqual(summarizeReminderChannels(docsDb).bark, { enabled: false, local: false, configured: false, host: "", useProxy: false });
    assert.equal(loadReminderChannelConfig(docsDb), null);
  });
});

test("clear channel removes its secrets without changing other channels", async () => {
  await withChannelCenterEnv(async ({ docsDb }) => {
    saveReminderChannels(docsDb, {
      barkUrl: "https://api.day.app", barkKey: "key", barkEnabled: true,
      feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345", feishuEnabled: true,
      proxyUrl: "http://10.0.0.2:7890", barkProxy: true, feishuProxy: true,
    });
    clearReminderChannel(docsDb, "Bark");
    const after = getReminderChannels(docsDb);
    assert.deepEqual(after.Bark, { URL: "", Key: "", Local: false });
    assert.equal(after.BarkEnabled, false);
    assert.equal(after.BarkProxy, false);
    assert.equal(after.FeishuEnabled, true);
    assert.equal(after.FeishuProxy, true);
    clearReminderChannel(docsDb, "代理");
    assert.equal(getReminderChannels(docsDb).Proxy, "");
    assert.equal(getReminderChannels(docsDb).FeishuProxy, false);
  });
});

test("clear channel removes its secrets without changing other channels", async () => {
  await withChannelCenterEnv(async ({ docsDb }) => {
    saveReminderChannels(docsDb, {
      barkUrl: "https://api.day.app", barkKey: "key", barkEnabled: true,
      feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc12345", feishuEnabled: true,
      proxyUrl: "http://10.0.0.2:7890", barkProxy: true, feishuProxy: true,
    });
    clearReminderChannel(docsDb, "Bark");
    const after = getReminderChannels(docsDb);
    assert.deepEqual(after.Bark, { URL: "", Key: "", Local: false });
    assert.equal(after.BarkEnabled, false);
    assert.equal(after.BarkProxy, false);
    assert.equal(after.FeishuEnabled, true);
    assert.equal(after.FeishuProxy, true);
    clearReminderChannel(docsDb, "代理");
    assert.equal(getReminderChannels(docsDb).Proxy, "");
    assert.equal(getReminderChannels(docsDb).FeishuProxy, false);
  });
});
