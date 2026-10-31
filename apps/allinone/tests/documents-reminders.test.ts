// 证件到期提醒测试：设置默认值/持久化、当日去重（跨重启）、北京时间小时匹配、
// 到期证件筛选（daysLeft 0–30）、消息格式（分组聚合）、Bark 失败重试语义、
// 关闭跳过、stocks 库/Bark 配置缺失跳过。
// 全部通过 barkSender 注入桩发送，绝不做真实网络推送（唯一的"网络"是 127.0.0.1 本地回环 mock）。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EXPIRY_WARN_DAYS,
  addDuration,
  todayStr,
} from "../src/lib/documents/constants.ts";
import {
  createDocument,
  createHolder,
  listDocuments,
  openDocumentsDB,
} from "../src/lib/documents/db.ts";
import {
  REMINDER_DEFAULT_HOUR,
  REMINDER_TITLE,
  buildReminderMessage,
  getReminderSettings,
  markReminderSent,
  reminderDue,
  saveReminderSettings,
  selectExpiringDocuments,
  shanghaiHour,
} from "../src/lib/documents/reminders.ts";
import {
  defaultBarkSender,
  loadBarkConfigFromStocks,
  runDocumentExpiryCheck,
  startDocumentReminderScheduler,
  stopDocumentReminderSchedulerForTest,
  type BarkSender,
  type ReminderCheckOptions,
} from "../src/lib/documents/reminders-run.ts";
import type { BarkConfig } from "../src/modules/stocks/notify.ts";
import { setDB as setStocksDB } from "../src/modules/stocks/store.ts";

// 固定“现在”：北京时间 2026-11-05 09:00（UTC 01:00），便于确定性断言。
const NOW = Date.UTC(2026, 10, 5, 1, 0, 0);
const TODAY = "2026-11-05";
const HOUR_AT_NOW = 9;

const FAKE_BARK: BarkConfig = { URL: "https://bark.example.com", Key: "test-key", Local: false };

type SenderCall = { config: BarkConfig; title: string; body: string };
type BarkStatus = "成功" | "失败" | "不确定";

function senderStub(status: BarkStatus, error = ""): { sender: BarkSender; calls: SenderCall[] } {
  const calls: SenderCall[] = [];
  const sender: BarkSender = async (config, title, body) => {
    calls.push({ config, title, body });
    return { status, error };
  };
  return { sender, calls };
}

function baseOpts(sender: BarkSender, overrides: ReminderCheckOptions = {}): ReminderCheckOptions {
  return { barkSender: sender, barkConfig: () => FAKE_BARK, nowMs: NOW, ...overrides };
}

function tempDb(): { db: ReturnType<typeof openDocumentsDB>; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-reminders-"));
  const db = openDocumentsDB(root);
  return { db, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function seedDoc(
  db: ReturnType<typeof openDocumentsDB>,
  title: string,
  expiryDate: string,
  holderId?: number,
  startDate?: string,
): number {
  return createDocument(db, { title, expiryType: "date", expiryDate, holderId, startDate });
}

// —— 设置：默认值 + 持久化 ——

test("reminder settings default to disabled/9h/null and persist with validation", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.deepEqual(getReminderSettings(db), { enabled: false, hour: REMINDER_DEFAULT_HOUR, lastSentDate: null });

    const saved = saveReminderSettings(db, { enabled: true, hour: 22 });
    assert.deepEqual(saved, { enabled: true, hour: 22, lastSentDate: null });
    assert.deepEqual(getReminderSettings(db), { enabled: true, hour: 22, lastSentDate: null });
    const row = db.prepare(`SELECT enabled,hour,last_sent_date FROM reminder_settings WHERE id=1`).get() as {
      enabled: number;
      hour: number;
    };
    assert.equal(row.enabled, 1);
    assert.equal(row.hour, 22);

    // 重新打开同一文件：设置仍在（持久化而非内存态）。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-reminders-file-"));
    const file = path.join(root, "documents.db");
    const first = openDocumentsDB(undefined, file);
    saveReminderSettings(first, { enabled: true, hour: 6 });
    markReminderSent(first, TODAY);
    first.close();
    const second = openDocumentsDB(undefined, file);
    assert.deepEqual(getReminderSettings(second), { enabled: true, hour: 6, lastSentDate: TODAY });
    second.close();
    fs.rmSync(root, { recursive: true, force: true });

    // 非法小时被拒绝且不改动既有设置。
    for (const bad of [24, -1, 9.5, Number.NaN, "abc"]) {
      assert.throws(() => saveReminderSettings(db, { enabled: true, hour: bad as number }), /0–23/, String(bad));
    }
    assert.deepEqual(getReminderSettings(db), { enabled: true, hour: 22, lastSentDate: null });

    // 当日标记可清除（供重试语义使用）。
    markReminderSent(db, TODAY);
    assert.equal(getReminderSettings(db).lastSentDate, TODAY);
    markReminderSent(db, null);
    assert.equal(getReminderSettings(db).lastSentDate, null);
  } finally {
    db.close();
    cleanup();
  }
});

// —— 当日去重：跨重启仍然生效 ——

test("once-per-day dedup by last_sent_date survives restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-reminders-dedup-"));
  const file = path.join(root, "documents.db");
  try {
    const db = openDocumentsDB(undefined, file);
    const holder = createHolder(db, "爸爸");
    seedDoc(db, "因私护照", addDuration(TODAY, 5, "day"), holder);
    saveReminderSettings(db, { enabled: true, hour: HOUR_AT_NOW });

    const first = senderStub("成功");
    const r1 = await runDocumentExpiryCheck(db, baseOpts(first.sender));
    assert.equal(r1.ran, true);
    assert.equal(r1.sent, true);
    assert.equal(r1.today, TODAY);
    assert.equal(r1.hour, HOUR_AT_NOW);
    assert.equal(r1.dueCount, 1);
    assert.equal(first.calls.length, 1);
    assert.deepEqual(getReminderSettings(db), { enabled: true, hour: HOUR_AT_NOW, lastSentDate: TODAY });

    // 同一天同一时刻再跑：去重，不再发送。
    const second = senderStub("成功");
    const r2 = await runDocumentExpiryCheck(db, baseOpts(second.sender));
    assert.equal(r2.ran, false);
    assert.equal(r2.reason, "already_sent_today");
    assert.equal(r2.alreadySentToday, true);
    assert.equal(second.calls.length, 0);
    db.close();

    // 跨重启（重新打开数据库文件）：去重标记持久化，依旧不发送。
    const reopened = openDocumentsDB(undefined, file);
    const third = senderStub("成功");
    const r3 = await runDocumentExpiryCheck(reopened, baseOpts(third.sender));
    assert.equal(r3.ran, false);
    assert.equal(r3.reason, "already_sent_today");
    assert.equal(third.calls.length, 0);
    assert.equal(getReminderSettings(reopened).lastSentDate, TODAY);
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// —— 北京时间小时匹配 ——

test("hour matching uses Asia/Shanghai wall clock", async () => {
  const { db, cleanup } = tempDb();
  try {
    seedDoc(db, "驾照", addDuration(TODAY, 10, "day"));
    saveReminderSettings(db, { enabled: true, hour: 9 });

    // 北京时间 08:59 → 不到点。
    const tooEarly = senderStub("成功");
    const early = await runDocumentExpiryCheck(db, baseOpts(tooEarly.sender, { nowMs: Date.UTC(2026, 10, 5, 0, 59, 59) }));
    assert.equal(early.ran, false);
    assert.equal(early.reason, "hour_mismatch");
    assert.equal(early.hour, 8);
    assert.equal(early.today, TODAY);
    assert.equal(tooEarly.calls.length, 0);

    // 北京时间 09:00 → 到点发送。
    const onTime = senderStub("成功");
    const due = await runDocumentExpiryCheck(db, baseOpts(onTime.sender, { nowMs: Date.UTC(2026, 10, 5, 1, 0, 0) }));
    assert.equal(due.ran, true);
    assert.equal(due.sent, true);
    assert.equal(onTime.calls.length, 1);

    // UTC 15:30 = 北京 23:30；UTC 16:00 = 北京次日 00:00（todayStr 同步翻日）。
    assert.equal(shanghaiHour(Date.UTC(2026, 10, 5, 15, 30, 0)), 23);
    assert.equal(shanghaiHour(Date.UTC(2026, 10, 5, 16, 0, 0)), 0);
    assert.equal(reminderDue({ enabled: true, hour: 0, lastSentDate: "2026-11-06" }, Date.UTC(2026, 10, 5, 16, 0, 0)).reason, "already_sent_today");
    const midnight = reminderDue({ enabled: true, hour: 0, lastSentDate: null }, Date.UTC(2026, 10, 5, 16, 0, 0));
    assert.equal(midnight.due, true);
    assert.equal(midnight.hour, 0);
    assert.equal(midnight.today, "2026-11-06");
    // 日期去重与小时判断都按北京时间，不受宿主机时区影响。
    assert.equal(todayStr(NOW), TODAY);
  } finally {
    db.close();
    cleanup();
  }
});

// —— 筛选：只选 daysLeft 0–30 的「即将到期」证件 ——

test("selects only expiring docs (daysLeft 0..30), not expired/upcoming/valid", async () => {
  const { db, cleanup } = tempDb();
  try {
    const holder = createHolder(db, "妈妈");
    const d0 = seedDoc(db, "身份证", TODAY, holder); // daysLeft 0
    const d30 = seedDoc(db, "护照", addDuration(TODAY, EXPIRY_WARN_DAYS, "day"), holder); // daysLeft 30
    seedDoc(db, "社保卡", addDuration(TODAY, EXPIRY_WARN_DAYS + 1, "day")); // 还早 → 排除
    seedDoc(db, "旧保单", addDuration(TODAY, -1, "day")); // 已过期 → 排除
    seedDoc(db, "长期证件", ""); // 无到期日 → 排除
    seedDoc(db, "未生效合同", "", undefined, addDuration(TODAY, 5, "day")); // 尚未生效 → 排除

    const docs = listDocuments(db, TODAY);
    const selected = selectExpiringDocuments(docs);
    assert.deepEqual(selected.map((d) => d.id), [d0, d30]); // 按 daysLeft 升序
    assert.deepEqual(selected.map((d) => d.daysLeft), [0, EXPIRY_WARN_DAYS]);
    assert.ok(selected.every((d) => d.status === "expiring"));

    const { sender, calls } = senderStub("成功");
    saveReminderSettings(db, { enabled: true, hour: HOUR_AT_NOW });
    const result = await runDocumentExpiryCheck(db, baseOpts(sender));
    assert.equal(result.ran, true);
    assert.equal(result.dueCount, 2);
    assert.equal(calls.length, 1);
    const body = calls[0].body;
    assert.match(body, /身份证/);
    assert.match(body, /护照/);
    assert.doesNotMatch(body, /社保卡|旧保单|长期证件|未生效合同/);
  } finally {
    db.close();
    cleanup();
  }
});

// —— 消息格式：标题固定 + 按持有人分组 + 列出标题与到期日 ——

test("message format: fixed title, per-holder groups, title+expiry lines", async () => {
  const { db, cleanup } = tempDb();
  try {
    const dad = createHolder(db, "爸爸");
    const mom = createHolder(db, "妈妈");
    seedDoc(db, "爸爸护照", addDuration(TODAY, 5, "day"), dad);
    seedDoc(db, "爸爸驾照", TODAY, dad); // 今天到期，排序应在 5 天前
    seedDoc(db, "妈妈签证", addDuration(TODAY, 12, "day"), mom);
    seedDoc(db, "家庭保单", addDuration(TODAY, 3, "day")); // 无持有人
    const selected = selectExpiringDocuments(listDocuments(db, TODAY));

    const { title, body } = buildReminderMessage(selected);
    assert.equal(title, REMINDER_TITLE);
    assert.equal(title, "证件到期提醒");
    const lines = body.split("\n");
    assert.equal(lines[0], `共有 4 份证件将在 ${EXPIRY_WARN_DAYS} 天内到期：`);
    // 分组头：每个持有人恰好一次，顺序为「剩余天数升序后各持有人首次出现顺序」（爸爸→未指定→妈妈）。
    const dadIdx = lines.indexOf("【爸爸】");
    const momIdx = lines.indexOf("【妈妈】");
    const noneIdx = lines.indexOf("【未指定持有人】");
    assert.ok(dadIdx > -1 && momIdx > -1 && noneIdx > -1);
    assert.equal(lines.filter((l) => l === "【爸爸】").length, 1);
    assert.equal(lines.filter((l) => l === "【妈妈】").length, 1);
    assert.equal(lines.filter((l) => l === "【未指定持有人】").length, 1);
    // 行格式：证件标题 + 到期日 + 剩余天数
    assert.ok(lines.includes(`· 爸爸驾照 ${TODAY}（今天到期）`));
    assert.ok(lines.includes(`· 爸爸护照 ${addDuration(TODAY, 5, "day")}（还剩 5 天）`));
    assert.ok(lines.includes(`· 家庭保单 ${addDuration(TODAY, 3, "day")}（还剩 3 天）`));
    // 组头先于组内条目；同组条目在组内按剩余天数升序，组与组连续不交错。
    const licenseIdx = lines.findIndex((l) => l.startsWith("· 爸爸驾照"));
    const passportIdx = lines.findIndex((l) => l.startsWith("· 爸爸护照"));
    const visaIdx = lines.findIndex((l) => l.startsWith("· 妈妈签证"));
    const policyIdx = lines.findIndex((l) => l.startsWith("· 家庭保单"));
    assert.ok(dadIdx < licenseIdx && licenseIdx < passportIdx);
    assert.ok(passportIdx < noneIdx && noneIdx < policyIdx);
    assert.ok(policyIdx < momIdx && momIdx < visaIdx);

    // 推送侧使用同一消息（聚合为一条，而非每份证件一条）。
    saveReminderSettings(db, { enabled: true, hour: HOUR_AT_NOW });
    const result = await runDocumentExpiryCheck(db, baseOpts(async (config, t, b) => {
      assert.equal(t, REMINDER_TITLE);
      assert.equal(b, body);
      return { status: "成功", error: "" };
    }));
    assert.equal(result.sent, true);
    assert.equal(result.dueCount, 4);
  } finally {
    db.close();
    cleanup();
  }
});

// —— Bark 失败：不崩溃、不写当日标记、下一轮自动重试 ——

test("bark failure keeps last_sent_date unset so the next tick retries", async () => {
  const { db, cleanup } = tempDb();
  try {
    seedDoc(db, "护照", addDuration(TODAY, 7, "day"));
    saveReminderSettings(db, { enabled: true, hour: HOUR_AT_NOW });

    const failing = senderStub("失败", "Bark HTTP 500");
    const r1 = await runDocumentExpiryCheck(db, baseOpts(failing.sender));
    assert.equal(r1.ran, true);
    assert.equal(r1.sent, false);
    assert.equal(r1.sendStatus, "失败");
    assert.equal(r1.sendError, "Bark HTTP 500");
    assert.equal(r1.lastSentDate, null);
    assert.equal(getReminderSettings(db).lastSentDate, null);

    // 失败后同一天内不会被去重挡住：重试成功才落标记。
    const retry = senderStub("成功");
    const r2 = await runDocumentExpiryCheck(db, baseOpts(retry.sender));
    assert.equal(r2.ran, true);
    assert.equal(r2.sent, true);
    assert.equal(retry.calls.length, 1);
    assert.equal(getReminderSettings(db).lastSentDate, TODAY);

    // 发送实现抛异常同样被吞掉，不向上传播。
    const throwing: BarkSender = async () => {
      throw new Error("socket exploded");
    };
    markReminderSent(db, null);
    const r3 = await runDocumentExpiryCheck(db, baseOpts(throwing));
    assert.doesNotThrow(() => Promise.resolve(r3));
    assert.equal(r3.sent, false);
    assert.equal(r3.sendStatus, "失败");
    assert.match(r3.sendError, /socket exploded/);
    assert.equal(getReminderSettings(db).lastSentDate, null);

    // 「不确定」送达视为已处理（避免重复轰炸），落当日标记但 sent=false。
    markReminderSent(db, null);
    const uncertain = senderStub("不确定", "Bark 网络异常或超时，发送结果不确定");
    const r4 = await runDocumentExpiryCheck(db, baseOpts(uncertain.sender));
    assert.equal(r4.sent, false);
    assert.equal(r4.sendStatus, "不确定");
    assert.equal(getReminderSettings(db).lastSentDate, TODAY);
  } finally {
    db.close();
    cleanup();
  }
});

// —— 开关关闭：直接跳过 ——

test("enabled=false skips the check entirely unless forced", async () => {
  const { db, cleanup } = tempDb();
  try {
    seedDoc(db, "护照", addDuration(TODAY, 7, "day"));
    saveReminderSettings(db, { enabled: false, hour: HOUR_AT_NOW });

    const { sender, calls } = senderStub("成功");
    const skipped = await runDocumentExpiryCheck(db, baseOpts(sender));
    assert.equal(skipped.ran, false);
    assert.equal(skipped.reason, "disabled");
    assert.equal(skipped.enabled, false);
    assert.equal(calls.length, 0);
    assert.equal(getReminderSettings(db).lastSentDate, null);

    // 手动「立即检查」（force）即使关闭也执行：用户显式要求。
    const forced = senderStub("成功");
    const forcedRun = await runDocumentExpiryCheck(db, baseOpts(forced.sender, { force: true }));
    assert.equal(forcedRun.ran, true);
    assert.equal(forcedRun.sent, true);
    assert.equal(forced.calls.length, 1);
  } finally {
    db.close();
    cleanup();
  }
});

// —— stocks 库 / Bark 配置缺失：优雅跳过 ——

test("missing bark config or stocks db skips gracefully without crash", async () => {
  const { db, cleanup } = tempDb();
  const originalDataDir = process.env.DATA_DIR;
  try {
    seedDoc(db, "护照", addDuration(TODAY, 7, "day"));
    saveReminderSettings(db, { enabled: true, hour: HOUR_AT_NOW });

    // 注入：Bark 配置不可用（等价于未配置/无效）。
    const { sender, calls } = senderStub("成功");
    const skipped = await runDocumentExpiryCheck(db, baseOpts(sender, { barkConfig: () => null }));
    assert.equal(skipped.ran, false);
    assert.equal(skipped.reason, "bark_unavailable");
    assert.equal(calls.length, 0);
    assert.equal(getReminderSettings(db).lastSentDate, null);

    // 默认加载器：DATA_DIR 指向空目录（stocks 库不存在 → 自动建空库，Bark 未配置）。
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "documents-reminders-stocks-"));
    process.env.DATA_DIR = emptyRoot;
    setStocksDB(null);
    try {
      assert.equal(loadBarkConfigFromStocks(), null);
      const { sender: s2, calls: c2 } = senderStub("成功");
      const viaDefault = await runDocumentExpiryCheck(db, baseOpts(s2, { barkConfig: undefined }));
      assert.equal(viaDefault.ran, false);
      assert.equal(viaDefault.reason, "bark_unavailable");
      assert.equal(c2.length, 0);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }

    // 默认加载器：stocks 库损坏（无 settings 表）→ 同样返回 null，不抛错。
    const broken = new Database(":memory:");
    setStocksDB(broken as unknown as Parameters<typeof setStocksDB>[0]);
    try {
      assert.equal(loadBarkConfigFromStocks(), null);
    } finally {
      broken.close();
      setStocksDB(null);
    }
  } finally {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    db.close();
    cleanup();
  }
});

// —— 默认发送实现 = stocks sendBark（仅打本地回环 mock，无真实网络推送） ——

test("default barkSender wires to stocks sendBark against a loopback mock", async () => {
  const { db, cleanup } = tempDb();
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/push");
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
    });
    req.on("end", () => {
      bodies.push(raw);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 200, message: "success" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    seedDoc(db, "回环护照", addDuration(TODAY, 9, "day"));
    saveReminderSettings(db, { enabled: true, hour: HOUR_AT_NOW });
    const address = server.address() as { address: string; port: number };
    const localBark: BarkConfig = { URL: `http://127.0.0.1:${address.port}`, Key: "loopback-test", Local: true };
    const result = await runDocumentExpiryCheck(db, {
      barkConfig: () => localBark, // 不注入 barkSender → 走默认 sendBark
      nowMs: NOW,
    });
    assert.equal(result.ran, true);
    assert.equal(result.sent, true);
    assert.equal(result.sendStatus, "成功");
    assert.equal(bodies.length, 1);
    const payload = JSON.parse(bodies[0]) as { device_key: string; title: string; body: string; group: string };
    assert.equal(payload.device_key, "loopback-test");
    assert.equal(payload.title, REMINDER_TITLE);
    assert.match(payload.body, /回环护照/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    db.close();
    cleanup();
  }
});

// —— 调度器：DISABLE_SCHEDULER 守卫 + 重复调用安全 ——

test("scheduler start respects DISABLE_SCHEDULER and is idempotent", () => {
  const original = process.env.DISABLE_SCHEDULER;
  process.env.DISABLE_SCHEDULER = "1";
  try {
    assert.doesNotThrow(() => {
      startDocumentReminderScheduler();
      startDocumentReminderScheduler(); // 重复注册安全
    });
  } finally {
    stopDocumentReminderSchedulerForTest();
    if (original === undefined) delete process.env.DISABLE_SCHEDULER;
    else process.env.DISABLE_SCHEDULER = original;
  }
});
