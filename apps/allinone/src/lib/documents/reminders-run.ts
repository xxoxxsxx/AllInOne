// 证件到期提醒：检查 + 发送编排（供 Server Actions 与 instrumentation 调度器复用）。
//
// 数据流：
//   1. 读 reminder_settings（documents.db，见 ./reminders）。
//   2. 按 Asia/Shanghai 墙钟判断是否到点（小时匹配）且今天未推送过（last_sent_date 去重）。
//   3. 选出到期证件（daysLeft 0–30），组装一条聚合推送。
//   4. 渠道配置来自全局推送渠道中心（DATA_DIR/channels/channels.db，见 @/lib/channels/center，
//      经 ./reminders-channels 委托读取），与行情（TickerSentry）设置零运行时依赖。
//      enabledChannels() 决定本次启用哪些渠道
//      （Bark / 飞书 / Telegram），逐渠道走 stocks notify 的 sendChannel —— 自动继承各渠道的
//      启用开关、代理开关与 sendBark/sendFeishu/sendTelegram 的 URL/内网校验等安全逻辑。
//      飞书/Telegram 文本为 `${title}\n${body}`（sendChannel 内拼接），Bark 保持 title/body 分离。
//      配置读取失败 → 视为未配置，静默跳过，绝不抛错、绝不写 last_sent_date。
//
// 聚合语义沿用 channelStatus：全部成功→成功；有成功→部分成功；有不确定→不确定；否则失败。
// 聚合为 成功/部分成功/不确定 都视为「已处理」并写 last_sent_date（避免重复轰炸）；
// 仅 失败（没有任何渠道成功）不写标记，下一轮 tick 自动重试。

import type Database from "better-sqlite3";

import {
  channelStatus,
  enabledChannels,
  sendChannel,
  type ChannelConfig,
  type SendOutcome,
} from "@/modules/stocks/notify";

import { filterModuleChannels, getModulePolicy } from "@/lib/channels/module-policy";
import { todayStr } from "./constants";
import { loadReminderChannelConfig } from "./reminders-channels";
import { listDocuments } from "./db";
import {
  buildReminderMessage,
  getReminderSettings,
  markReminderSent,
  reminderDue,
  selectExpiringDocuments,
  type ReminderDueReason,
  type ReminderSettings,
} from "./reminders";

/** 单渠道发送结果（供 UI 与测试展示）。 */
export type ChannelSendResult = { name: string; status: string; error: string };

/** 发送函数注入点：签名与 stocks notify 的 sendChannel 一致；测试用桩替换，避免真实网络推送。 */
export type ChannelSender = (config: ChannelConfig, name: string, title: string, body: string) => Promise<SendOutcome>;

export type ReminderSkipReason =
  | ReminderDueReason
  | "channels_unavailable"
  | "no_due_documents";

export type ReminderRunResult = {
  /** 是否执行到了「选证件 + 推送」阶段（到点且通过去重）。 */
  ran: boolean;
  /** 聚合结果为「成功」时为 true（部分成功/不确定视为已处理但 sent=false）。 */
  sent: boolean;
  /** ran=false 时的跳过原因；ran=true 时为空串。 */
  reason: ReminderSkipReason | "";
  /** 本次使用的 Asia/Shanghai 日期与当前小时。 */
  today: string;
  hour: number;
  settingsHour: number;
  enabled: boolean;
  alreadySentToday: boolean;
  /** 选出的到期证件数。 */
  dueCount: number;
  /** 渠道聚合结果（channelStatus 语义：成功/部分成功/不确定/失败）。 */
  sendStatus: string;
  /** 未成功渠道的错误摘要（“渠道：错误”，成功渠道不列入）。 */
  sendError: string;
  /** 各渠道发送明细。 */
  channels: ChannelSendResult[];
  /** 运行后的 last_sent_date（仅 失败 时不更新）。 */
  lastSentDate: string | null;
};

export type ReminderCheckOptions = {
  /** 注入发送实现（sendChannel 同签名）；默认使用 stocks notify 的真实 sendChannel。 */
  channelSender?: ChannelSender;
  /** 注入渠道配置来源；默认读全局推送渠道中心（见 loadReminderChannelConfig）。 */
  channelsConfig?: () => ChannelConfig | null;
  /** 覆盖当前时间（ms），测试北京时间小时匹配用。 */
  nowMs?: number;
  /** 手动触发：忽略开关/小时/当日去重，但渠道配置与到期证件仍必须存在。 */
  force?: boolean;
};

const EMPTY_RESULT = {
  dueCount: 0,
  sendStatus: "",
  sendError: "",
  channels: [] as ChannelSendResult[],
};

/** 默认发送实现：stocks notify 的 sendChannel（自动按渠道拼接飞书/TG 文本、应用代理与安全校验）。 */
export const defaultChannelSender: ChannelSender = (config, name, title, body) =>
  sendChannel(config, name, title, body);

/**
 * 逐渠道推送（enabledChannels 决定渠道集合），并按 channelStatus 聚合。
 * 单渠道发送实现抛错按该渠道「失败」处理，不影响其他渠道。
 */
export async function dispatchToEnabledChannels(
  config: ChannelConfig,
  title: string,
  body: string,
  sender: ChannelSender = defaultChannelSender,
): Promise<{ aggregate: string; channels: ChannelSendResult[] }> {
  const channels: ChannelSendResult[] = [];
  for (const name of enabledChannels(config)) {
    let outcome: SendOutcome;
    try {
      outcome = await sender(config, name, title, body);
    } catch (error) {
      outcome = { status: "失败", error: error instanceof Error ? error.message : "发送异常" };
    }
    channels.push({ name, status: outcome.status, error: outcome.error });
  }
  const aggregate = channelStatus(channels.map((c) => ({ Name: c.name, Status: c.status, Error: c.error })));
  return { aggregate, channels };
}

function skip(
  settings: ReminderSettings,
  today: string,
  hour: number,
  reason: ReminderSkipReason,
): ReminderRunResult {
  return {
    ...EMPTY_RESULT,
    ran: false,
    sent: false,
    reason,
    today,
    hour,
    settingsHour: settings.hour,
    enabled: settings.enabled,
    alreadySentToday: settings.lastSentDate === today && today !== "",
    lastSentDate: settings.lastSentDate,
  };
}

function sendErrorSummary(channels: ChannelSendResult[]): string {
  return channels
    .filter((c) => c.status !== "成功")
    .map((c) => `${c.name}：${c.error || c.status}`)
    .join("；");
}

/**
 * 执行一次证件到期检查。除非 force，只有「开关开启 + 北京时间小时匹配 + 今日未推送」
 * 且选出到期证件时才真正推送；聚合结果非「失败」才写 last_sent_date（当日去重，跨重启仍有效）。
 */
export async function runDocumentExpiryCheck(
  db: Database.Database,
  opts: ReminderCheckOptions = {},
): Promise<ReminderRunResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const today = todayStr(nowMs);
  const settings = getReminderSettings(db);
  const due = reminderDue(settings, nowMs);

  if (!opts.force && !due.due) {
    return skip(settings, today, due.hour, due.reason);
  }
  const hour = due.hour;

  // 渠道配置默认取自全局推送渠道中心（channels.db），与行情设置无关。
  const globalConfig = opts.channelsConfig ? opts.channelsConfig() : loadReminderChannelConfig(db);
  // 证件夹只使用模块渠道选择；自动总开关唯一来源为 reminder_settings.enabled。
  const config = globalConfig ? filterModuleChannels(globalConfig, {
    ...getModulePolicy(db, "documents", true), enabled: true,
  }) : null;
  if (!config || enabledChannels(config).length === 0) {
    return skip(settings, today, hour, "channels_unavailable");
  }

  const dueDocs = selectExpiringDocuments(listDocuments(db, today));
  if (dueDocs.length === 0) return skip(settings, today, hour, "no_due_documents");

  const { title, body } = buildReminderMessage(dueDocs);
  const { aggregate, channels } = await dispatchToEnabledChannels(config, title, body, opts.channelSender);

  // 成功/部分成功/不确定 都视为已处理（不确定 = 送达未知，重发可能造成重复通知）；
  // 仅 失败（没有任何渠道成功）不写 last_sent_date，下一轮 tick 重试。
  const delivered = aggregate !== "失败";
  const lastSentDate = settings.lastSentDate;
  if (delivered) {
    markReminderSent(db, today);
  }
  return {
    ran: true,
    sent: aggregate === "成功",
    reason: "",
    today,
    hour,
    settingsHour: settings.hour,
    enabled: settings.enabled,
    alreadySentToday: delivered ? true : lastSentDate === today,
    dueCount: dueDocs.length,
    sendStatus: aggregate,
    sendError: sendErrorSummary(channels),
    channels,
    lastSentDate: delivered ? today : lastSentDate,
  };
}

// —— 应用内调度器：每 10 分钟 tick 一次，到点由 runDocumentExpiryCheck 自行判断 ——

const TICK_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 30 * 1000;

let schedulerStarted = false;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** 注册证件到期提醒调度器；不抛错、可重复调用、定时器 unref 不阻塞进程退出。 */
export function startDocumentReminderScheduler(): void {
  if (schedulerStarted) return;
  if (process.env.DISABLE_SCHEDULER === "1") return;
  schedulerStarted = true;
  const tick = (): void => {
    void (async () => {
      try {
        const { getDocumentsDB } = await import("./db");
        await runDocumentExpiryCheck(getDocumentsDB());
      } catch (error) {
        console.error("证件到期提醒检查失败", error);
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
export function stopDocumentReminderSchedulerForTest(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (tickTimer) clearInterval(tickTimer);
  firstTimer = null;
  tickTimer = null;
  schedulerStarted = false;
}
