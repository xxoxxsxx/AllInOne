// 提醒事项调度器与投递编排（供 Server Actions 与 instrumentation 复用）。
// 每个 tick（30s）：
//   1. 恢复到期重试（retry_at ≤ now，跨重启仍有效）；
//   2. computeDue 判定到期 → 先持久化行更新（at-most-once，绝不重复轰炸）再投递；
//   3. missed 更新（单次超 24h / 停机跳过）直接落库并写 missed 日志，不需要渠道；
//   4. 渠道不可用 → 本轮跳过投递（到期货保持待投，下轮自动恢复；missed 不受影响）；
//   5. 投递：Bark/飞书发文字；Telegram 有图片时 multipart 直传首图（多图只列计数）。
//      聚合语义沿用 channelStatus（成功/部分成功/不确定/失败）；
//      成功→sent（catchup→catchup）；其余非失败→partial；失败→ +1min/+5min 重试（≤2 次），
//      最终失败写 failed 日志并经同一组渠道发一条「提醒事项 · 投递失败」管理告警（仅一条）。
// 每次尝试/错失都写 reminder_fire_log（含 missed）。
//
// 渠道配置默认来自 src/lib/channels/center.ts 的 getChannelConfig()（与行情共用一套渠道设置，
// 由并行落地的 center 模块提供；读取失败视为未配置，本轮跳过投递，绝不抛错）。
// 测试通过注入 channelsConfig / channelSender / photoSender 替身，绝不做真实网络推送。

import type Database from "better-sqlite3";

import { enabledChannels, channelStatus, type ChannelConfig, type SendOutcome } from "@/modules/stocks/notify";
import { filterModuleChannels, getModulePolicy } from "@/lib/channels/module-policy";
import {
  defaultChannelSender,
  dispatchToEnabledChannels,
  type ChannelSendResult,
  type ChannelSender,
} from "@/lib/documents/reminders-run";

import { ALERT_TITLE, REMINDERS_TITLE, buildChannelMessage, sendTelegramPhoto } from "./dispatch";
import { scheduledAtOf, computeDue, type ScheduleLike } from "./schedules";
import {
  applyScheduleUpdates,
  getRemindersDB,
  getReminder,
  listRetryDueSchedules,
  listRunSchedules,
  logFire,
  readReminderAttachment,
  setScheduleRetry,
} from "./store";

/** 图片上传注入点：签名与 dispatch.sendTelegramPhoto 一致；测试用桩替换。 */
export type PhotoSender = (
  config: ChannelConfig,
  buffer: Buffer,
  filename: string,
  mime: string,
  caption: string,
) => Promise<SendOutcome>;

export const defaultPhotoSender: PhotoSender = (config, buffer, filename, mime, caption) =>
  sendTelegramPhoto(config, buffer, filename, caption, mime);

/**
 * 渠道配置默认来源：动态加载全局渠道中心（src/lib/channels/center.ts，与行情/证件夹共用），
 * 用其 loadChannelConfig()（读取失败返回 null，调用方按未配置跳过投递，永不抛错）。
 * 动态引入以保持 reminders 与渠道中心的惰性耦合（测试注入 channelsConfig 时不触达中心库）。
 */
let defaultChannelsConfigCache: (() => Promise<ChannelConfig | null>) | null = null;
export function defaultChannelsConfig(): () => Promise<ChannelConfig | null> {
  if (defaultChannelsConfigCache) return defaultChannelsConfigCache;
  defaultChannelsConfigCache = async () => {
    try {
      const mod = (await import("@/lib/channels/center")) as { loadChannelConfig: () => ChannelConfig | null };
      return mod.loadChannelConfig();
    } catch (error) {
      console.error("提醒事项：读取渠道配置失败，本轮跳过投递", error);
      return null;
    }
  };
  return defaultChannelsConfigCache;
}

export type RemindersRunOptions = {
  /** 注入数据库（默认全局单例）。 */
  db?: Database.Database;
  /** 覆盖当前时间（ms）。 */
  nowMs?: number;
  /** 注入渠道配置来源（默认渠道中心 getChannelConfig）。 */
  channelsConfig?: () => ChannelConfig | null | Promise<ChannelConfig | null>;
  /** 注入文本发送实现（与 documents ChannelSender 同签名）。 */
  channelSender?: ChannelSender;
  /** 注入 Telegram 图片发送实现。 */
  photoSender?: PhotoSender;
};

export type TickDispatch = {
  scheduleId: number;
  reminderId: number;
  /** 聚合结果：成功/部分成功/不确定/失败。 */
  status: string;
  /** 处理方式：sent / catchup / partial / retry / failed / alert。 */
  action: string;
  detail: string;
  channels: ChannelSendResult[];
};

export type RemindersTickResult = {
  ran: boolean;
  reason: string;
  dueCount: number;
  delivered: number;
  catchupCount: number;
  missedCount: number;
  retryScheduled: number;
  dispatches: TickDispatch[];
};

function errorSummary(channels: ChannelSendResult[]): string {
  return channels
    .filter((c) => c.status !== "成功")
    .map((c) => `${c.name}：${c.error || c.status}`)
    .join("；");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function describeMissed(missed: true | { skipped: number; fromMs: number; toMs: number; nextMs: number | null } | undefined): string {
  if (missed === true) return "单次提醒错过超过宽限期（24 小时），不再推送";
  if (missed && typeof missed === "object") {
    return `停机期间跳过 ${missed.skipped} 次触发（${iso(missed.fromMs)} ～ ${iso(missed.toMs)}），已恢复至未来触发`;
  }
  return "错过且不再推送";
}

type DeliveryEntry = {
  schedule: ScheduleLike;
  text: string;
  scheduledAtMs: number;
  catchup: boolean;
  retryCount: number;
};

/** 组装并逐渠道投递一条提醒；返回聚合结果与渠道明细。 */
async function deliver(
  db: Database.Database,
  entry: DeliveryEntry,
  config: ChannelConfig,
  opts: RemindersRunOptions,
): Promise<{ aggregate: string; channels: ChannelSendResult[] }> {
  const sender = opts.channelSender ?? defaultChannelSender;
  const photoSender = opts.photoSender ?? defaultPhotoSender;
  const reminder = getReminder(db, entry.schedule.reminderId);
  const text = reminder?.text ?? entry.text;
  const images = reminder?.images ?? [];
  const { title, body } = buildChannelMessage({ text, imageCount: images.length }, entry.catchup);
  const results: ChannelSendResult[] = [];
  for (const name of enabledChannels(config)) {
    let outcome: SendOutcome;
    try {
      if (name === "Telegram" && images.length > 0) {
        const first = images[0]!;
        const data = readReminderAttachment(first.reminderId, first.storedName);
        if (data) {
          outcome = await photoSender(config, data, first.storedName, first.mime, `${title}\n${body}`);
        } else {
          // 附件读取失败降级为纯文本，不让图片问题阻断提醒本体。
          outcome = await sender(config, name, title, body);
        }
      } else {
        outcome = await sender(config, name, title, body);
      }
    } catch (error) {
      outcome = { status: "失败", error: error instanceof Error ? error.message : "发送异常" };
    }
    results.push({ name, status: outcome.status, error: outcome.error });
  }
  const aggregate = channelStatus(results.map((c) => ({ Name: c.name, Status: c.status, Error: c.error })));
  return { aggregate, channels: results };
}

/** 单条到期/重试投递：成功落 sent/catchup/partial，失败进重试链或终局告警。 */
async function deliverOne(
  db: Database.Database,
  entry: DeliveryEntry,
  config: ChannelConfig,
  opts: RemindersRunOptions,
  nowMs: number,
): Promise<TickDispatch> {
  const { aggregate, channels } = await deliver(db, entry, config, opts);
  const scheduledIso = iso(entry.scheduledAtMs);
  const base = { scheduleId: entry.schedule.id, reminderId: entry.schedule.reminderId, channels };
  if (aggregate !== "失败") {
    // 与证件提醒一致的语义：不确定（送达未知）不重试，避免重复轰炸。
    const status = aggregate === "成功" ? (entry.catchup ? "catchup" : "sent") : "partial";
    logFire(db, {
      scheduleId: entry.schedule.id,
      scheduledAt: scheduledIso,
      status,
      detail: aggregate === "成功" ? (entry.catchup ? "补发成功" : "推送成功") : `未完全送达（${aggregate}：${errorSummary(channels)}）`,
      channelResults: channels,
      attemptedAt: iso(nowMs),
    });
    return { ...base, status: aggregate, action: status, detail: aggregate, channels };
  }

  const summary = errorSummary(channels) || aggregate;
  if (entry.retryCount < 2) {
    const delayMs = entry.retryCount === 0 ? 60_000 : 300_000;
    setScheduleRetry(db, entry.schedule.id, {
      retryAt: nowMs + delayMs,
      retryCount: entry.retryCount + 1,
      scheduledAt: entry.scheduledAtMs,
      catchup: entry.catchup,
    });
    logFire(db, {
      scheduleId: entry.schedule.id,
      scheduledAt: scheduledIso,
      status: "retry",
      detail: `投递失败（${summary}），${delayMs / 1000} 秒后第 ${entry.retryCount + 1} 次重试`,
      channelResults: channels,
      attemptedAt: iso(nowMs),
    });
    return { ...base, status: aggregate, action: "retry", detail: summary, channels };
  }

  // 重试耗尽：终局失败 + 一条管理告警（同一组渠道）。
  setScheduleRetry(db, entry.schedule.id, null);
  logFire(db, {
    scheduleId: entry.schedule.id,
    scheduledAt: scheduledIso,
    status: "failed",
    detail: `投递失败（${summary}），重试耗尽，已发送管理告警`,
    channelResults: channels,
    attemptedAt: iso(nowMs),
  });
  const alertBody = [
    `提醒「${entry.text.slice(0, 50)}${entry.text.length > 50 ? "…" : ""}」投递失败。`,
    `计划时刻：${scheduledIso}`,
    `失败原因：${summary}`,
    "已停止自动重试，请检查推送渠道配置。",
  ].join("\n");
  let alertDetail = "";
  try {
    const alert = await dispatchToEnabledChannels(config, ALERT_TITLE, alertBody, opts.channelSender ?? defaultChannelSender);
    alertDetail = `管理告警：${alert.aggregate}`;
  } catch (error) {
    alertDetail = `管理告警发送异常：${error instanceof Error ? error.message : "未知错误"}`;
  }
  logFire(db, {
    scheduleId: entry.schedule.id,
    scheduledAt: scheduledIso,
    status: "failed",
    detail: alertDetail,
    channelResults: [],
    attemptedAt: iso(nowMs),
  });
  return { ...base, status: aggregate, action: "failed", detail: `${summary}；${alertDetail}`, channels };
}

/**
 * 执行一次提醒调度 tick。幂等安全：重复调用/并发调用不产生重复投递（行更新先于投递落库）。
 */
export async function runRemindersTick(opts: RemindersRunOptions = {}): Promise<RemindersTickResult> {
  const db = opts.db ?? getRemindersDB();
  const now = opts.nowMs ?? Date.now();
  const policy = getModulePolicy(db, "reminders");
  // 关闭模块时不推进计划或重试状态；重新开启后沿用原有错过/补发规则。
  if (!policy.enabled) return { ran: false, reason: "module_disabled", dueCount: 0, delivered: 0, catchupCount: 0, missedCount: 0, retryScheduled: 0, dispatches: [] };
  const runSchedules = listRunSchedules(db);
  const retryDue = listRetryDueSchedules(db, now);
  const { due, updates } = computeDue({ schedules: runSchedules.map((r) => r.schedule), now });
  const dueById = new Map(due.map((d) => [d.schedule.id, d]));
  const textById = new Map(runSchedules.map((r) => [r.schedule.id, r.text]));

  // missed 更新（once 超宽限 / 停机跳过）先落库并记日志；不需要渠道可用。
  const missedUpdates = updates.filter((u) => !dueById.has(u.id));
  applyScheduleUpdates(db, missedUpdates, now);
  let missedCount = 0;
  for (const u of missedUpdates) {
    const schedule = runSchedules.find((r) => r.schedule.id === u.id)?.schedule;
    const fallbackMs = u.missed && typeof u.missed === "object" ? u.missed.toMs : now;
    const scheduledAtMs = (schedule ? scheduledAtOf(schedule) : null) ?? fallbackMs;
    logFire(db, {
      scheduleId: u.id,
      scheduledAt: iso(scheduledAtMs),
      status: "missed",
      detail: describeMissed(u.missed),
      channelResults: [],
      attemptedAt: iso(now),
    });
    missedCount++;
  }

  const globalConfig = await (opts.channelsConfig ? opts.channelsConfig() : defaultChannelsConfig()());
  const config = globalConfig ? filterModuleChannels(globalConfig, policy) : null;
  const emptyResult: RemindersTickResult = {
    ran: false,
    reason: "",
    dueCount: due.length + retryDue.length,
    delivered: 0,
    catchupCount: 0,
    missedCount,
    retryScheduled: 0,
    dispatches: [],
  };
  if (!config || enabledChannels(config).length === 0) {
    return { ...emptyResult, reason: "channels_unavailable" };
  }

  const dispatches: TickDispatch[] = [];
  let delivered = 0;
  let catchupCount = 0;
  let retryScheduled = 0;

  // 常规到期：先持久化行更新（at-most-once），再逐条投递。
  const dueUpdates = updates.filter((u) => dueById.has(u.id));
  applyScheduleUpdates(db, dueUpdates, now);
  // 与到期更新一并落库的停机跳过（interval 多槽位 / cron 停机窗口）：补一条 missed 日志。
  for (const u of dueUpdates) {
    if (!(u.missed && typeof u.missed === "object")) continue;
    logFire(db, {
      scheduleId: u.id,
      scheduledAt: iso(u.missed.fromMs),
      status: "missed",
      detail: describeMissed(u.missed),
      channelResults: [],
      attemptedAt: iso(now),
    });
  }
  for (const d of due) {
    const entry: DeliveryEntry = {
      schedule: d.schedule,
      text: textById.get(d.schedule.id) ?? "",
      scheduledAtMs: scheduledAtOf(d.schedule) ?? now,
      catchup: d.catchup,
      retryCount: 0,
    };
    const result = await deliverOne(db, entry, config, opts, now);
    dispatches.push(result);
    if (result.action === "sent" || result.action === "partial") delivered++;
    if (result.action === "catchup") catchupCount++;
    if (result.action === "retry") retryScheduled++;
  }

  // 到期重试恢复（上一轮失败后的 +1min/+5min）。
  for (const r of retryDue) {
    const entry: DeliveryEntry = {
      schedule: r.schedule,
      text: r.text,
      scheduledAtMs: r.scheduledAt,
      catchup: r.catchup,
      retryCount: r.retryCount,
    };
    const result = await deliverOne(db, entry, config, opts, now);
    dispatches.push(result);
    if (result.action === "sent" || result.action === "partial" || result.action === "catchup") delivered++;
    if (result.action === "retry") retryScheduled++;
  }

  return {
    ran: true,
    reason: "",
    dueCount: due.length + retryDue.length,
    delivered,
    catchupCount,
    missedCount,
    retryScheduled,
    dispatches,
  };
}

/** 手动「立即测试」：按真实投递路径发一条测试消息，不改任何调度状态；返回渠道明细。 */
export async function sendReminderTest(
  reminderId: number,
  opts: RemindersRunOptions = {},
): Promise<{ ok: true; aggregate: string; channels: ChannelSendResult[] } | { ok: false; error: string }> {
  const db = opts.db ?? getRemindersDB();
  const now = opts.nowMs ?? Date.now();
  const globalConfig = await (opts.channelsConfig ? opts.channelsConfig() : defaultChannelsConfig()());
  // 手动测试独立于自动开关，但仍遵守本模块的渠道选择。
  const config = globalConfig ? filterModuleChannels(globalConfig, getModulePolicy(db, "reminders")) : null;
  if (!config || enabledChannels(config).length === 0) {
    return { ok: false, error: "尚未配置任何推送渠道：请先启用并配置 Bark / 飞书 / Telegram 至少一个渠道" };
  }
  const reminder = getReminder(db, reminderId);
  if (!reminder) return { ok: false, error: "提醒不存在或已删除" };
  const schedule = reminder.schedules[0];
  const { aggregate, channels } = await deliver(
    db,
    {
      schedule: {
        id: schedule?.id ?? -1,
        reminderId,
        kind: schedule?.kind ?? "once",
        at: null,
        startAt: null,
        intervalSeconds: null,
        total: null,
        sent: 0,
        cron: null,
        nextAt: null,
        enabled: true,
        missedAt: null,
      },
      text: reminder.text,
      scheduledAtMs: now,
      catchup: false,
      retryCount: 0,
    },
    config,
    opts,
  );
  logFire(db, {
    scheduleId: schedule?.id ?? -1,
    scheduledAt: iso(now),
    status: aggregate === "成功" ? "sent" : aggregate === "失败" ? "failed" : "partial",
    detail: `手动测试：${aggregate}（${errorSummary(channels) || "无错误"}）`,
    channelResults: channels,
    attemptedAt: iso(now),
  });
  return { ok: true, aggregate, channels };
}

// —— 应用内调度器：每 30 秒 tick 一次 ——

const TICK_INTERVAL_MS = 30 * 1000;
const FIRST_TICK_DELAY_MS = 5 * 1000;

let schedulerStarted = false;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/** 注册提醒事项调度器；不抛错、可重复调用、定时器 unref 不阻塞进程退出。 */
export function startRemindersScheduler(): void {
  if (schedulerStarted) return;
  if (process.env.DISABLE_SCHEDULER === "1") return;
  schedulerStarted = true;
  const tick = (): void => {
    if (tickInFlight) return;
    tickInFlight = true;
    void (async () => {
      try {
        await runRemindersTick();
      } catch (error) {
        console.error("提醒事项调度失败", error);
      } finally {
        tickInFlight = false;
      }
    })();
  };
  firstTimer = setTimeout(tick, FIRST_TICK_DELAY_MS);
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  for (const t of [firstTimer, tickTimer]) {
    if (typeof t === "object" && t !== null && "unref" in t) (t as { unref(): void }).unref();
  }
}

// 供测试：停止调度循环。
export function stopRemindersSchedulerForTest(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (tickTimer) clearInterval(tickTimer);
  firstTimer = null;
  tickTimer = null;
  schedulerStarted = false;
  tickInFlight = false;
}

export { REMINDERS_TITLE };
