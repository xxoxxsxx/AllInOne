import test from "node:test";
import assert from "node:assert/strict";

import { EMPTY_CHANNEL_CONFIG, type ReminderChannelsSummary } from "../src/lib/channels/center.ts";
import { runRemindersTick, sendReminderTest, type RemindersRunOptions } from "../src/lib/reminders/run.ts";
import { createReminder, getReminder, listFireLog, openRemindersDB } from "../src/lib/reminders/store.ts";
import type { ChannelConfig, SendOutcome } from "@/modules/stocks/notify";
import type { ChannelSendResult } from "@/lib/documents/reminders-run.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 2, 5, 9, 0, 30).getTime(); // 任意固定基准（本地时间构造，时区无关）

/** Bark+飞书 双渠道配置（走 enabledChannels 的真实判定，不发网络请求）。 */
function twoChannelConfig(): ChannelConfig {
  return {
    ...EMPTY_CHANNEL_CONFIG,
    BarkEnabled: true,
    Bark: { ...EMPTY_CHANNEL_CONFIG.Bark, URL: "https://bark.example.com", Key: "test-key" },
    FeishuEnabled: true,
    FeishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  };
}

/** 渠道发送 spy：按渠道名映射结果并记录全部调用。 */
function spySender(outcomes: Record<string, "成功" | "失败"> = { Bark: "成功", 飞书: "成功" }) {
  const calls: Array<{ name: string; title: string; body: string }> = [];
  const sender = async (config: ChannelConfig, name: string, title: string, body: string): Promise<SendOutcome> => {
    calls.push({ name, title, body });
    return outcomes[name] === "失败" ? { status: "失败", error: "模拟网络故障" } : { status: "成功", error: "" };
  };
  return { calls, sender };
}

type OnceReminder = { id: number; scheduleId: number };
function createOnce(db: NonNullable<RemindersRunOptions["db"]>, atMs: number, text = "记得交物业费"): OnceReminder {
  const id = createReminder(db, { text, schedules: [{ kind: "once", at: new Date(atMs) }] });
  const scheduleId = getReminder(db, id)!.schedules[0]!.id;
  return { id, scheduleId };
}

test("channels unavailable: tick does nothing but still logs overdue misses", async () => {
  const db = openRemindersDB();
  createOnce(db, T0 - 25 * HOUR); // 超宽限期，直接判错过
  const result = await runRemindersTick({ db, nowMs: T0, channelsConfig: async () => null });
  assert.equal(result.ran, false);
  assert.equal(result.reason, "channels_unavailable");
  assert.equal(result.missedCount, 1);
  const log = listFireLog(db);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.status, "missed");
  assert.match(log[0]!.detail, /宽限期/);
});

test("once due: delivers to every enabled channel and logs sent", async () => {
  const db = openRemindersDB();
  createOnce(db, T0 - 30_000);
  const { calls, sender } = spySender();
  const result = await runRemindersTick({ db, nowMs: T0, channelsConfig: async () => twoChannelConfig(), channelSender: sender });
  assert.equal(result.ran, true);
  assert.equal(result.delivered, 1);
  assert.equal(result.dispatches[0]!.action, "sent");
  assert.equal(calls.length, 2, "Bark + 飞书 both receive the push");
  assert.ok(calls.every((c) => c.title === "⏰ 提醒事项"));
  assert.ok(calls.every((c) => c.body === "记得交物业费"));
  const view = getReminder(db, result.dispatches[0]!.reminderId)!;
  assert.equal(view.schedules[0]!.sent, 1);
  assert.equal(view.schedules[0]!.nextAt, null, "once schedules close after firing");
  const log = listFireLog(db, view.schedules[0]!.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.status, "sent");
});

test("once catchup: title carries the [补发] marker and log records catchup", async () => {
  const db = openRemindersDB();
  createOnce(db, T0 - 2 * HOUR);
  const { calls, sender } = spySender();
  const result = await runRemindersTick({ db, nowMs: T0, channelsConfig: async () => twoChannelConfig(), channelSender: sender });
  assert.equal(result.catchupCount, 1);
  assert.ok(calls.every((c) => c.title === "[补发] ⏰ 提醒事项"));
  const log = listFireLog(db)[0]!;
  assert.equal(log.status, "catchup");
  assert.match(log.detail, /补发成功/);
});

test("once beyond grace: marked missed without any push", async () => {
  const db = openRemindersDB();
  createOnce(db, T0 - DAY - HOUR);
  const { calls, sender } = spySender();
  const result = await runRemindersTick({ db, nowMs: T0, channelsConfig: async () => twoChannelConfig(), channelSender: sender });
  assert.equal(result.ran, true);
  assert.equal(result.missedCount, 1);
  assert.equal(result.dispatches.length, 0);
  assert.equal(calls.length, 0, "beyond-grace reminders must not push");
  assert.equal(listFireLog(db)[0]!.status, "missed");
});

test("partial channel failure counts as delivered without retry", async () => {
  const db = openRemindersDB();
  createOnce(db, T0 - 30_000);
  const { calls, sender } = spySender({ Bark: "成功", 飞书: "失败" });
  const result = await runRemindersTick({ db, nowMs: T0, channelsConfig: async () => twoChannelConfig(), channelSender: sender });
  assert.equal(result.dispatches[0]!.status, "部分成功");
  assert.equal(result.dispatches[0]!.action, "partial");
  assert.equal(result.delivered, 1);
  assert.equal(result.retryScheduled, 0);
  const schedule = getReminder(db, result.dispatches[0]!.reminderId)!.schedules[0]!;
  assert.equal(schedule.retryAt, null);
  const log = listFireLog(db, schedule.id)[0]!;
  assert.equal(log.status, "partial");
  assert.match(log.detail, /未完全送达/);
  assert.deepEqual(
    log.channelResults!.map((c: ChannelSendResult) => c.name),
    ["Bark", "飞书"],
  );
});

test("failed delivery retries twice then sends one admin alert", async () => {
  const db = openRemindersDB();
  createOnce(db, T0 - 30_000);
  const { calls, sender } = spySender({ Bark: "失败", 飞书: "失败" });
  const opts = (nowMs: number): RemindersRunOptions => ({
    db,
    nowMs,
    channelsConfig: async () => twoChannelConfig(),
    channelSender: sender,
  });

  const first = await runRemindersTick(opts(T0));
  assert.equal(first.dispatches[0]!.action, "retry");
  assert.equal(first.retryScheduled, 1);
  const schedule = () => getReminder(db, first.dispatches[0]!.reminderId)!.schedules[0]!;
  assert.equal(schedule().retryCount, 1);
  const retryAt1 = Date.parse(schedule().retryAt!);
  assert.equal(retryAt1 - T0, MIN, "first retry waits 1 minute");

  const second = await runRemindersTick(opts(T0 + MIN + 1000));
  assert.equal(second.dispatches[0]!.action, "retry");
  assert.equal(schedule().retryCount, 2);
  const retryAt2 = Date.parse(schedule().retryAt!);
  assert.equal(retryAt2 - (T0 + MIN + 1000), 5 * MIN, "second retry waits 5 minutes");

  const final = await runRemindersTick(opts(retryAt2 + 1000));
  assert.equal(final.dispatches[0]!.action, "failed");
  assert.equal(schedule().retryAt, null, "retry chain closed after exhaustion");
  assert.equal(schedule().retryCount, 0);
  // 双渠道：投递 3 次（首次 + 两次重试）各 2 渠道 + 管理告警 2 渠道 = 8 次调用。
  assert.equal(calls.length, 8);
  const alertCalls = calls.filter((c) => c.title === "提醒事项 · 投递失败");
  assert.equal(alertCalls.length, 2, "exactly one admin alert per enabled channel");
  const statuses = listFireLog(db, schedule().id).map((l) => l.status);
  // 重试耗尽写两条审计行（新→旧）：管理告警投递结果 + 投递终局；再往前是两次重试。
  assert.deepEqual(statuses, ["failed", "failed", "retry", "retry"]);
  assert.match(listFireLog(db, schedule().id)[0]!.detail, /管理告警/);
  assert.match(listFireLog(db, schedule().id)[1]!.detail, /重试耗尽/);
});

test("cron schedule fires via tick with catchup and recomputes next_at", async () => {
  const db = openRemindersDB();
  // 创建于 09:00:30，next_at 解析为 09:05；tick 设为 09:07 → 以 [补发] 投递并跳至 09:10。
  const id = createReminder(db, { text: "每天吃维生素", schedules: [{ kind: "cron", cron: "*/5 * * * *" }] }, T0);
  const scheduleId = getReminder(db, id)!.schedules[0]!.id;
  const nextAtBefore = Date.parse(getReminder(db, id)!.schedules[0]!.nextAt!);
  assert.equal(new Date(nextAtBefore).getMinutes() % 5, 0);

  const { calls, sender } = spySender();
  const result = await runRemindersTick({ db, nowMs: T0 + 6.5 * MIN, channelsConfig: async () => twoChannelConfig(), channelSender: sender });
  assert.equal(result.delivered + result.catchupCount, 1);
  assert.equal(result.dispatches[0]!.action, "catchup", "next_at 已经过去 90 秒，按补发投递");
  assert.ok(calls.every((c) => c.title === "[补发] ⏰ 提醒事项"));
  const nextAtAfter = Date.parse(getReminder(db, id)!.schedules[0]!.nextAt!);
  assert.ok(nextAtAfter > T0 + 6.5 * MIN, "next_at recomputed strictly into the future");
});

test("interval downtime logs the skipped gap and keeps remaining occurrences", async () => {
  const db = openRemindersDB();
  // 每 60s 一次共 5 次，start 在 200s 前：4 个槽位已过（发最新一个，3 个记跳过），1 个在未来保留。
  const id = createReminder(db, {
    text: "每小时喝口水",
    schedules: [{ kind: "interval", startAt: new Date(T0 - 200_000), intervalSeconds: 60, total: 5 }],
  }, T0 - 200_000);
  const { sender } = spySender();
  const result = await runRemindersTick({ db, nowMs: T0, channelsConfig: async () => twoChannelConfig(), channelSender: sender });
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.dispatches[0]!.action, "sent", "latest slot is 20 seconds old: a normal delivery");
  const gap = listFireLog(db).filter((l) => l.status === "missed");
  assert.equal(gap.length, 1, "skipped slots get exactly one missed log entry");
  assert.match(gap[0]!.detail, /跳过 3 次触发/);
  const schedule = getReminder(db, id)!.schedules[0]!;
  assert.equal(schedule.sent, 1, "skipped slots do not consume the quota");
  assert.ok(schedule.nextAt !== null && Date.parse(schedule.nextAt) > T0, "remaining occurrences are preserved");
});

test("sendReminderTest pushes once without touching schedule state", async () => {
  const db = openRemindersDB();
  const created = createOnce(db, T0 + HOUR, "测试文字");
  const { calls, sender } = spySender();
  const opts: RemindersRunOptions = { db, channelsConfig: async () => twoChannelConfig(), channelSender: sender };
  const result = await sendReminderTest(created.id, opts);
  assert.ok(result.ok);
  assert.equal(result.aggregate, "成功");
  assert.equal(calls.length, 2);
  const view = getReminder(db, created.id)!;
  assert.equal(view.schedules[0]!.sent, 0, "test sends never consume schedule state");
  const log = listFireLog(db);
  assert.equal(log.length, 1, "test sends are audited as manual fire-log entries");
  assert.equal(log[0]!.status, "sent");
  assert.match(log[0]!.detail, /手动测试/);

  const noChannels = await sendReminderTest(created.id, { db, channelsConfig: async () => null, channelSender: sender });
  assert.deepEqual(noChannels, { ok: false, error: "尚未配置任何推送渠道：请先启用并配置 Bark / 飞书 / Telegram 至少一个渠道" });
  const missing = await sendReminderTest(9999, opts);
  assert.deepEqual(missing, { ok: false, error: "提醒不存在或已删除" });
});

test("summary type stays secrets-free (contract guard for the channel center)", () => {
  // 防御性契约检查：ReminderChannelsSummary 的序列化结果绝不包含 Key/Token/Webhook 字段。
  const summary: ReminderChannelsSummary = {
    bark: { enabled: true, local: false, configured: true, host: "bark.example.com", useProxy: false },
    feishu: { enabled: true, configured: true, useProxy: false },
    telegram: { enabled: false, configured: false, useProxy: false },
    proxy: { configured: false },
  };
  const json = JSON.stringify(summary);
  assert.ok(!/key|token|webhook|secret/i.test(json));
});
