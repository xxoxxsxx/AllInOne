// 证件到期提醒：检查 + 发送编排（供 Server Actions 与 instrumentation 调度器复用）。
//
// 数据流：
//   1. 读 reminder_settings（documents.db，见 ./reminders）。
//   2. 按 Asia/Shanghai 墙钟判断是否到点（小时匹配）且今天未推送过（last_sent_date 去重）。
//   3. 选出到期证件（daysLeft 0–30），组装一条聚合推送。
//   4. Bark 复用 stocks 模块的配置（data/tickersentry/ticker.db 的 settings.bark_*）与 sendBark。
//      stocks 库缺失/未配置/配置无效时静默跳过，绝不抛错、绝不写 last_sent_date。
//
// 推送失败（含不确定送达之外的失败）不落 last_sent_date，下一轮 tick 会自动重试。

import type Database from "better-sqlite3";

import { barkSettings, getDB as getStocksDB } from "@/modules/stocks/store";
import { checkBarkURL, sendBark, type BarkConfig, type SendOutcome } from "@/modules/stocks/notify";

import { todayStr } from "./constants";
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

/** 发送函数注入点：测试用桩替换，避免真实网络推送。 */
export type BarkSender = (config: BarkConfig, title: string, body: string) => Promise<SendOutcome>;

export type ReminderSkipReason =
  | ReminderDueReason
  | "bark_unavailable"
  | "no_due_documents";

export type ReminderRunResult = {
  /** 是否执行到了「选证件 + 推送」阶段（到点且通过去重）。 */
  ran: boolean;
  /** Bark 返回「成功」时为 true（「不确定」视为已送达以免重复轰炸，但 sent 仍为 false）。 */
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
  /** Bark 发送结果（成功/失败/不确定）。 */
  sendStatus: string;
  sendError: string;
  /** 运行后的 last_sent_date（失败时不更新）。 */
  lastSentDate: string | null;
};

export type ReminderCheckOptions = {
  /** 注入发送实现；默认使用 stocks 模块的真实 sendBark（不带代理）。 */
  barkSender?: BarkSender;
  /** 注入 Bark 配置来源；默认读 stocks 库（见 loadBarkConfigFromStocks）。 */
  barkConfig?: () => BarkConfig | null;
  /** 覆盖当前时间（ms），测试北京时间小时匹配用。 */
  nowMs?: number;
  /** 手动触发：忽略开关/小时/当日去重，但 bark 配置与到期证件仍必须存在。 */
  force?: boolean;
};

const EMPTY_RESULT = {
  dueCount: 0,
  sendStatus: "",
  sendError: "",
};

/** 复用 stocks 的 Bark 配置：库打不开/未配置/URL 无效一律返回 null（永不抛错）。 */
export function loadBarkConfigFromStocks(): BarkConfig | null {
  try {
    const stocksDB = getStocksDB();
    const raw = barkSettings(stocksDB);
    if (!raw || raw.URL.trim() === "" || raw.Key.trim() === "") return null;
    const url = checkBarkURL(raw.URL, raw.Local);
    return { URL: url, Key: raw.Key, Local: raw.Local };
  } catch {
    // stocks 库缺失、表结构损坏或 URL 校验失败：视为未配置 Bark。
    return null;
  }
}

/** 默认发送实现：直连 stocks 的 sendBark（证件提醒不使用行情代理）。 */
export const defaultBarkSender: BarkSender = (config, title, body) => sendBark(config, title, body, "");

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
    sendStatus: "",
    sendError: "",
    lastSentDate: settings.lastSentDate,
  };
}

/**
 * 执行一次证件到期检查。除非 force，只有「开关开启 + 北京时间小时匹配 + 今日未推送」
 * 且选出到期证件时才真正推送；推送确认送达后才写 last_sent_date（当日去重，跨重启仍有效）。
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

  const barkConfig = opts.barkConfig ? opts.barkConfig() : loadBarkConfigFromStocks();
  if (!barkConfig) return skip(settings, today, hour, "bark_unavailable");

  const dueDocs = selectExpiringDocuments(listDocuments(db, today));
  if (dueDocs.length === 0) return skip(settings, today, hour, "no_due_documents");

  const { title, body } = buildReminderMessage(dueDocs);
  const sender = opts.barkSender ?? defaultBarkSender;
  let outcome: SendOutcome;
  try {
    outcome = await sender(barkConfig, title, body);
  } catch (error) {
    // 发送实现抛错不向上传播：按失败处理，下一轮重试。
    outcome = { status: "失败", error: error instanceof Error ? error.message : "Bark 发送异常" };
  }

  // 「成功」或「不确定」都不再重试当日推送（不确定 = 送达未知，重发可能造成重复通知）；
  // 真失败则不写 last_sent_date，下一轮 tick 重试。
  const delivered = outcome.status === "成功" || outcome.status === "不确定";
  const lastSentDate = settings.lastSentDate;
  if (delivered) {
    markReminderSent(db, today);
  }
  return {
    ran: true,
    sent: outcome.status === "成功",
    reason: "",
    today,
    hour,
    settingsHour: settings.hour,
    enabled: settings.enabled,
    alreadySentToday: delivered ? true : lastSentDate === today,
    dueCount: dueDocs.length,
    sendStatus: outcome.status,
    sendError: outcome.error,
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
