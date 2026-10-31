// 证件到期提醒：纯逻辑 + 设置持久化（documents.db 的 reminder_settings 表）。
// Bark 渠道复用 stocks 模块的配置与发送实现，本文件不保存任何 Bark Key/URL，
// 也不含 Node 专属重依赖（better-sqlite3 仅作类型引用），便于测试直接加载。
//
// 时间语义：与证件夹一致，统一按 Asia/Shanghai 墙钟判断（todayStr / shanghaiHour），
// 避免容器与宿主机时区不同导致漏发或重发。

import type Database from "better-sqlite3";

import { EXPIRY_WARN_DAYS, todayStr } from "./constants";
import type { DocumentRecord } from "./db";

/** 提醒推送标题。 */
export const REMINDER_TITLE = "证件到期提醒";
/** 默认提醒时刻（Asia/Shanghai 小时）。 */
export const REMINDER_DEFAULT_HOUR = 9;

export type ReminderSettings = {
  enabled: boolean;
  hour: number;
  lastSentDate: string | null;
};

export type ReminderDueReason =
  | "disabled"
  | "hour_mismatch"
  | "already_sent_today"
  | "due";

// —— 设置持久化（CREATE TABLE IF NOT EXISTS，独立于 documents 迁移链） ——

export function ensureReminderSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      enabled INTEGER NOT NULL DEFAULT 0,
      hour INTEGER NOT NULL DEFAULT ${REMINDER_DEFAULT_HOUR} CHECK(hour BETWEEN 0 AND 23),
      last_sent_date TEXT
    );
    INSERT OR IGNORE INTO reminder_settings(id) VALUES(1);
  `);
}

/** 读取提醒设置；表不存在时自动建表并返回默认值（enabled=false, hour=9, lastSentDate=null）。 */
export function getReminderSettings(db: Database.Database): ReminderSettings {
  ensureReminderSchema(db);
  const r = db.prepare(`SELECT enabled,hour,last_sent_date FROM reminder_settings WHERE id=1`).get() as
    | { enabled: number; hour: number; last_sent_date: string | null }
    | undefined;
  if (!r) return { enabled: false, hour: REMINDER_DEFAULT_HOUR, lastSentDate: null };
  return {
    enabled: Number(r.enabled) === 1,
    hour: normalizeHour(r.hour),
    lastSentDate: r.last_sent_date ?? null,
  };
}

/** 保存开关与时刻；hour 必须是 0–23 的整数。返回保存后的完整设置。 */
export function saveReminderSettings(db: Database.Database, input: { enabled: boolean; hour: number }): ReminderSettings {
  const hour = normalizeHour(input.hour);
  ensureReminderSchema(db);
  db.prepare(
    `INSERT INTO reminder_settings(id,enabled,hour,last_sent_date) VALUES(1,?,?,NULL)
     ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, hour=excluded.hour`,
  ).run(input.enabled === true ? 1 : 0, hour);
  return getReminderSettings(db);
}

/** 记录（或清除）当日已推送标记；仅在推送确认送达后调用。 */
export function markReminderSent(db: Database.Database, date: string | null): void {
  ensureReminderSchema(db);
  db.prepare(`UPDATE reminder_settings SET last_sent_date=? WHERE id=1`).run(date);
}

function normalizeHour(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 23) throw new Error("提醒时间须为 0–23 的整数");
  return n;
}

// —— 时间判断 ——

/** Asia/Shanghai 当前小时（0–23，h23 制，不受宿主机时区影响）。 */
export function shanghaiHour(nowMs: number = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) throw new Error("当前小时无效");
  return hour;
}

/** 是否到了当日提醒时刻：开关开启 + 北京时间小时匹配 + 今天尚未推送过。 */
export function reminderDue(
  settings: ReminderSettings,
  nowMs: number = Date.now(),
): { due: boolean; reason: ReminderDueReason; today: string; hour: number } {
  const today = todayStr(nowMs);
  const hour = shanghaiHour(nowMs);
  if (!settings.enabled) return { due: false, reason: "disabled", today, hour };
  if (hour !== settings.hour) return { due: false, reason: "hour_mismatch", today, hour };
  if (settings.lastSentDate === today) return { due: false, reason: "already_sent_today", today, hour };
  return { due: true, reason: "due", today, hour };
}

// —— 选取与消息 —— 

/** 只选「即将到期」的证件：daysLeft ∈ [0, 30]；排除已过期 / 尚未生效 / 无到期日 / 还早。 */
export function selectExpiringDocuments(docs: DocumentRecord[]): DocumentRecord[] {
  return docs
    .filter(
      (d) =>
        d.status === "expiring" &&
        d.daysLeft !== null &&
        d.daysLeft >= 0 &&
        d.daysLeft <= EXPIRY_WARN_DAYS,
    )
    .sort((a, b) => (a.daysLeft as number) - (b.daysLeft as number) || a.title.localeCompare(b.title, "zh-Hans-CN"));
}

/**
 * 组装单条聚合推送（不是每份证件一条）：
 *   标题：证件到期提醒
 *   正文：按持有人分组，每组列出「证件名 到期日（剩余天数）」。
 */
export function buildReminderMessage(docs: DocumentRecord[]): { title: string; body: string } {
  const title = REMINDER_TITLE;
  if (docs.length === 0) return { title, body: "" };
  const groups = new Map<string, DocumentRecord[]>();
  for (const doc of docs) {
    const holder = doc.holderName?.trim() || "未指定持有人";
    const list = groups.get(holder) ?? [];
    list.push(doc);
    groups.set(holder, list);
  }
  const lines: string[] = [`共有 ${docs.length} 份证件将在 ${EXPIRY_WARN_DAYS} 天内到期：`];
  for (const [holder, list] of groups) {
    lines.push(`【${holder}】`);
    for (const doc of list) {
      const days = doc.daysLeft ?? 0;
      const when = days === 0 ? "今天到期" : `还剩 ${days} 天`;
      lines.push(`· ${doc.title} ${doc.expiryDate}（${when}）`);
    }
  }
  return { title, body: lines.join("\n") };
}
