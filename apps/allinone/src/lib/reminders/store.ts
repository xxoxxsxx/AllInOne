// 提醒事项 SQLite 存储：独立库文件 DATA_DIR/reminders/reminders.db（与证件夹/行情互不影响）。
// 结构：reminders（提醒）→ reminder_schedules（单次/间隔/cron 三类时间计划）与
// reminder_images（图片附件）；reminder_fire_log 记录每次投递尝试与错失。
// 附件文件保存在 DATA_DIR/reminders/attachments/<reminderId>/<stored_name>（随机文件名 + 白名单扩展名，
// 图片按文件头校验，不信任客户端 MIME）。
//
// 调度行时间语义：
//   once    → at（ISO，UTC 存储；由 datetime-local 的本地时间解析而来）
//   interval→ start_at + interval_seconds + total；next_at 为「下一个待处理槽位」指针
//   cron    → cron 表达式；next_at 为下一次触发（服务器本地时间计算，见 ./cron.ts）
// 补充列（超出任务书的最小表结构，用于跨 tick 的重试/错失状态持久化）：
//   missed_at（once 已错过）、retry_at / retry_count / retry_scheduled_at / retry_catchup（投递重试）、
//   这些状态全部落库，进程重启后恢复。

import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/data-dir";

import { nextFire, parseCron } from "./cron";
import {
  REMINDERS_MAX_IMAGES,
  REMINDERS_MAX_IMAGE_BYTES,
  REMINDERS_MAX_INTERVAL_SECONDS,
  REMINDERS_MAX_INTERVAL_TOTAL,
  REMINDERS_MAX_TEXT_LENGTH,
  REMINDERS_MIN_INTERVAL_SECONDS,
} from "./constants";
import type { ReminderScheduleKind, ScheduleUpdate } from "./schedules";

export const REMINDERS_SCHEMA_VERSION = 1;
export { REMINDERS_MAX_IMAGES as MAX_IMAGES_PER_REMINDER } from "./constants";
export { REMINDERS_MAX_IMAGE_BYTES as MAX_IMAGE_BYTES } from "./constants";
export { REMINDERS_MAX_TEXT_LENGTH as MAX_TEXT_LENGTH } from "./constants";
export { REMINDERS_MIN_INTERVAL_SECONDS as MIN_INTERVAL_SECONDS } from "./constants";
export { REMINDERS_MAX_INTERVAL_SECONDS as MAX_INTERVAL_SECONDS } from "./constants";
export { REMINDERS_MAX_INTERVAL_TOTAL as MAX_INTERVAL_TOTAL } from "./constants";
/** 允许的图片 MIME 与扩展名（文件头校验，见 validateImage）。 */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STORED_NAME_RE = /^[a-z0-9]+\.(jpg|png|webp)$/;

export type ScheduleInput = {
  kind: ReminderScheduleKind;
  /** once：本地时间（datetime-local 字符串或 Date）；存库折算为 ISO UTC。 */
  at?: string | Date | null;
  startAt?: string | Date | null;
  intervalSeconds?: number | null;
  total?: number | null;
  cron?: string | null;
  enabled?: boolean;
};

export type ReminderInput = {
  text: string;
  enabled?: boolean;
  schedules?: ScheduleInput[];
};

export type ScheduleView = {
  id: number;
  reminderId: number;
  kind: ReminderScheduleKind;
  at: string | null;
  startAt: string | null;
  intervalSeconds: number | null;
  total: number | null;
  sent: number;
  cron: string | null;
  nextAt: string | null;
  enabled: boolean;
  missedAt: string | null;
  retryAt: string | null;
  retryCount: number;
  retryScheduledAt: string | null;
  retryCatchup: boolean;
};

export type ImageView = {
  id: number;
  reminderId: number;
  storedName: string;
  originalName: string;
  mime: string;
  size: number;
};

export type ReminderView = {
  id: number;
  text: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  schedules: ScheduleView[];
  images: ImageView[];
};

export type FireLogEntry = {
  scheduleId: number;
  scheduledAt: string;
  status: "sent" | "partial" | "failed" | "retry" | "missed" | "catchup";
  detail?: string;
  channelResults?: Array<{ name: string; status: string; error: string }>;
  attemptedAt?: string;
};

declare global {
  var __remindersSqlite: Database.Database | undefined;
}

// —— 路径 ——

export function remindersRootDir(): string {
  return path.join(dataDir(), "reminders");
}

export function remindersDbPath(): string {
  return path.join(remindersRootDir(), "reminders.db");
}

export function attachmentsRoot(): string {
  return path.join(remindersRootDir(), "attachments");
}

export function attachmentDir(reminderId: number): string {
  return path.join(attachmentsRoot(), String(reminderId));
}

// —— 校验 ——

/** 校验图片内容与声明 MIME 一致（JPEG/PNG/WebP 文件头），不信任客户端 MIME。 */
export function validateImage(data: Buffer, mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error("不支持的图片格式（仅支持 JPEG/PNG/WebP）");
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error("图片内容为空");
  if (data.length > REMINDERS_MAX_IMAGE_BYTES) throw new Error(`单个图片不能超过 ${REMINDERS_MAX_IMAGE_BYTES / 1024 / 1024}MB`);
  let actualMime: string | null = null;
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    actualMime = "image/jpeg";
  } else if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    actualMime = "image/png";
  } else if (
    data.length >= 20 &&
    data.toString("latin1", 0, 4) === "RIFF" &&
    data.toString("latin1", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(data.toString("latin1", 12, 16)) &&
    data.readUInt32LE(4) === data.length - 8
  ) {
    actualMime = "image/webp";
  }
  if (actualMime !== mime) throw new Error("图片内容与格式不符（仅支持真实 JPEG/PNG/WebP 图片）");
  return ext;
}

function toEpochMs(value: string | Date | null | undefined, label: string): number {
  if (value === null || value === undefined || value === "") throw new Error(`${label}不能为空`);
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  // datetime-local 字符串（无时区后缀）按服务器本地时间解析。
  if (!Number.isFinite(ms)) throw new Error(`${label}无效`);
  return ms;
}

/** 校验并规范化一条调度；返回可直接入库的行（时间为 ISO UTC，next_at 已按当前时间算好）。 */
export function normalizeSchedule(input: ScheduleInput, nowMs: number): {
  kind: ReminderScheduleKind;
  at: string | null;
  startAt: string | null;
  intervalSeconds: number | null;
  total: number | null;
  cron: string | null;
  nextAt: string | null;
  enabled: number;
} {
  const enabled = input.enabled === false ? 0 : 1;
  if (input.kind === "once") {
    const ms = toEpochMs(input.at ?? null, "单次时间");
    return { kind: "once", at: new Date(ms).toISOString(), startAt: null, intervalSeconds: null, total: null, cron: null, nextAt: null, enabled };
  }
  if (input.kind === "interval") {
    const startMs = toEpochMs(input.startAt ?? null, "间隔起始时间");
    const seconds = Number(input.intervalSeconds);
    if (!Number.isInteger(seconds) || seconds < REMINDERS_MIN_INTERVAL_SECONDS || seconds > REMINDERS_MAX_INTERVAL_SECONDS) {
      throw new Error(`间隔时长须为 ${REMINDERS_MIN_INTERVAL_SECONDS}～${REMINDERS_MAX_INTERVAL_SECONDS} 秒`);
    }
    const total = Number(input.total);
    if (!Number.isInteger(total) || total < 1 || total > REMINDERS_MAX_INTERVAL_TOTAL) {
      throw new Error(`间隔次数须为 1～${REMINDERS_MAX_INTERVAL_TOTAL} 次`);
    }
    return {
      kind: "interval",
      at: null,
      startAt: new Date(startMs).toISOString(),
      intervalSeconds: seconds,
      total,
      cron: null,
      nextAt: new Date(startMs).toISOString(),
      enabled,
    };
  }
  if (input.kind === "cron") {
    const expr = (input.cron ?? "").trim();
    const check = parseCron(expr);
    if (!check.ok) throw new Error(`cron 表达式无效：${check.error}`);
    // 永不触发的表达式（如 0 0 31 2 *）合法但 next_at 为空，调度保持惰性。
    const next = nextFire(expr, new Date(nowMs));
    return {
      kind: "cron",
      at: null,
      startAt: null,
      intervalSeconds: null,
      total: null,
      cron: expr,
      nextAt: next === null ? null : next.toISOString(),
      enabled,
    };
  }
  throw new Error("调度类型无效（仅支持 单次/间隔/cron）");
}

function validateText(text: string): string {
  const value = typeof text === "string" ? text.trim() : "";
  if (value === "") throw new Error("提醒文字不能为空");
  if (value.length > REMINDERS_MAX_TEXT_LENGTH) throw new Error(`提醒文字不能超过 ${REMINDERS_MAX_TEXT_LENGTH} 字`);
  return value;
}

// —— 打开/迁移 ——

export function openRemindersDB(dir?: string, file = ":memory:"): Database.Database {
  const dbPath = file !== ":memory:" ? file : ":memory:";
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } else if (dir) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    db.transaction(() => migrate(db)).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function getRemindersDB(): Database.Database {
  if (!globalThis.__remindersSqlite) {
    globalThis.__remindersSqlite = openRemindersDB(undefined, remindersDbPath());
  }
  return globalThis.__remindersSqlite;
}

/** 测试专用：重置全局句柄后重新打开（独立临时 DATA_DIR 用）。 */
export function resetRemindersDBForTest(): void {
  const existing = globalThis.__remindersSqlite;
  if (existing) {
    try {
      existing.close();
    } catch {
      // 已关闭则忽略。
    }
  }
  globalThis.__remindersSqlite = undefined;
}

function migrate(db: Database.Database): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version > REMINDERS_SCHEMA_VERSION) {
    throw new Error(`reminders.db schema 版本过高（${version} > ${REMINDERS_SCHEMA_VERSION}），请升级程序。`);
  }
  if (version === REMINDERS_SCHEMA_VERSION) return;
  db.exec(`
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE reminder_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('once','interval','cron')),
      at TEXT,
      start_at TEXT,
      interval_seconds INTEGER,
      total INTEGER,
      sent INTEGER NOT NULL DEFAULT 0,
      cron TEXT,
      next_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      missed_at TEXT,
      retry_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_scheduled_at TEXT,
      retry_catchup INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_schedules_reminder ON reminder_schedules(reminder_id);
    CREATE INDEX idx_schedules_next ON reminder_schedules(next_at);
    CREATE TABLE reminder_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      stored_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL
    );
    CREATE INDEX idx_images_reminder ON reminder_images(reminder_id);
    CREATE TABLE reminder_fire_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent','partial','failed','retry','missed','catchup')),
      detail TEXT NOT NULL DEFAULT '',
      channel_results TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_fire_log_schedule ON reminder_fire_log(schedule_id);
  `);
  db.pragma(`user_version = ${REMINDERS_SCHEMA_VERSION}`);
}

// —— 行映射 ——

type ScheduleRow = {
  id: number;
  reminder_id: number;
  kind: string;
  at: string | null;
  start_at: string | null;
  interval_seconds: number | null;
  total: number | null;
  sent: number;
  cron: string | null;
  next_at: string | null;
  enabled: number;
  missed_at: string | null;
  retry_at: string | null;
  retry_count: number;
  retry_scheduled_at: string | null;
  retry_catchup: number;
};

function rowToSchedule(r: ScheduleRow): ScheduleView {
  return {
    id: r.id,
    reminderId: r.reminder_id,
    kind: r.kind as ReminderScheduleKind,
    at: r.at,
    startAt: r.start_at,
    intervalSeconds: r.interval_seconds,
    total: r.total,
    sent: r.sent,
    cron: r.cron,
    nextAt: r.next_at,
    enabled: r.enabled === 1,
    missedAt: r.missed_at,
    retryAt: r.retry_at,
    retryCount: r.retry_count,
    retryScheduledAt: r.retry_scheduled_at,
    retryCatchup: r.retry_catchup === 1,
  };
}

function rowToImage(r: { id: number; reminder_id: number; stored_name: string; original_name: string; mime: string; size: number }): ImageView {
  return {
    id: r.id,
    reminderId: r.reminder_id,
    storedName: r.stored_name,
    originalName: r.original_name,
    mime: r.mime,
    size: r.size,
  };
}

const SCHEDULE_COLUMNS =
  "id,reminder_id,kind,at,start_at,interval_seconds,total,sent,cron,next_at,enabled,missed_at,retry_at,retry_count,retry_scheduled_at,retry_catchup";

// —— CRUD ——

function insertSchedule(db: Database.Database, reminderId: number, s: ReturnType<typeof normalizeSchedule>): void {
  db.prepare(
    `INSERT INTO reminder_schedules(reminder_id,kind,at,start_at,interval_seconds,total,sent,cron,next_at,enabled)
     VALUES(?,?,?,?,?,?,0,?,?,?)`,
  ).run(reminderId, s.kind, s.at, s.startAt, s.intervalSeconds, s.total, s.cron, s.nextAt, s.enabled);
}

/** 新建提醒（含调度行）；调度全部校验通过才落库（事务），失败整体回滚。 */
export function createReminder(db: Database.Database, input: ReminderInput, nowMs = Date.now()): number {
  const text = validateText(input.text);
  const schedules = (input.schedules ?? []).map((s) => normalizeSchedule(s, nowMs));
  const now = new Date(nowMs).toISOString();
  return db.transaction(() => {
    const result = db
      .prepare("INSERT INTO reminders(text,created_at,updated_at,enabled) VALUES(?,?,?,?)")
      .run(text, now, now, input.enabled === false ? 0 : 1);
    const id = Number(result.lastInsertRowid);
    for (const s of schedules) insertSchedule(db, id, s);
    return id;
  }).immediate();
}

/** 更新提醒（文字/开关/调度整体替换：调度按提交内容重新起算）。 */
export function updateReminder(db: Database.Database, id: number, input: ReminderInput, nowMs = Date.now()): void {
  const text = validateText(input.text);
  const schedules = (input.schedules ?? []).map((s) => normalizeSchedule(s, nowMs));
  const now = new Date(nowMs).toISOString();
  db.transaction(() => {
    const exists = db.prepare("SELECT id FROM reminders WHERE id=?").get(id) as { id: number } | undefined;
    if (!exists) throw new Error("提醒不存在或已删除");
    db.prepare("UPDATE reminders SET text=?,updated_at=?,enabled=? WHERE id=?").run(
      text,
      now,
      input.enabled === false ? 0 : 1,
      id,
    );
    db.prepare("DELETE FROM reminder_schedules WHERE reminder_id=?").run(id);
    for (const s of schedules) insertSchedule(db, id, s);
  }).immediate();
}

export function setReminderEnabled(db: Database.Database, id: number, enabled: boolean, nowMs = Date.now()): void {
  const result = db
    .prepare("UPDATE reminders SET enabled=?,updated_at=? WHERE id=?")
    .run(enabled ? 1 : 0, new Date(nowMs).toISOString(), id);
  if (result.changes === 0) throw new Error("提醒不存在或已删除");
}

/** 删除提醒（级联删除调度/附件行）；返回附件文件清单供调用方清理磁盘。 */
export function deleteReminder(db: Database.Database, id: number): ImageView[] {
  return db.transaction(() => {
    const images = db.prepare("SELECT * FROM reminder_images WHERE reminder_id=?").all(id) as Array<Parameters<typeof rowToImage>[0]>;
    db.prepare("DELETE FROM reminders WHERE id=?").run(id);
    return images.map(rowToImage);
  }).immediate();
}

function imagesOf(db: Database.Database, reminderId: number): ImageView[] {
  return (db.prepare("SELECT * FROM reminder_images WHERE reminder_id=? ORDER BY id").all(reminderId) as Array<
    Parameters<typeof rowToImage>[0]
  >).map(rowToImage);
}

export function getReminder(db: Database.Database, id: number): ReminderView | null {
  const row = db.prepare("SELECT * FROM reminders WHERE id=?").get(id) as
    | { id: number; text: string; created_at: string; updated_at: string; enabled: number }
    | undefined;
  if (!row) return null;
  const schedules = (db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM reminder_schedules WHERE reminder_id=? ORDER BY id`).all(id) as ScheduleRow[]).map(rowToSchedule);
  return {
    id: row.id,
    text: row.text,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    schedules,
    images: imagesOf(db, id),
  };
}

export function listReminders(db: Database.Database): ReminderView[] {
  const rows = db.prepare("SELECT * FROM reminders ORDER BY id DESC").all() as Array<{
    id: number; text: string; created_at: string; updated_at: string; enabled: number;
  }>;
  const scheduleStmt = db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM reminder_schedules WHERE reminder_id=? ORDER BY id`);
  const imageStmt = db.prepare("SELECT * FROM reminder_images WHERE reminder_id=? ORDER BY id");
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    schedules: (scheduleStmt.all(row.id) as ScheduleRow[]).map(rowToSchedule),
    images: (imageStmt.all(row.id) as Array<Parameters<typeof rowToImage>[0]>).map(rowToImage),
  }));
}

// —— 调度器视角 ——

/** 调度行 + 提醒文字（投递组装消息用）；仅启用中的提醒与调度。 */
export type RunSchedule = { schedule: import("./schedules").ScheduleLike; text: string };

function scheduleToLike(r: ScheduleRow): import("./schedules").ScheduleLike {
  return {
    id: r.id,
    reminderId: r.reminder_id,
    kind: r.kind as ReminderScheduleKind,
    at: r.at === null ? null : Date.parse(r.at),
    startAt: r.start_at === null ? null : Date.parse(r.start_at),
    intervalSeconds: r.interval_seconds,
    total: r.total,
    sent: r.sent,
    cron: r.cron,
    nextAt: r.next_at === null ? null : Date.parse(r.next_at),
    enabled: r.enabled === 1,
    missedAt: r.missed_at === null ? null : Date.parse(r.missed_at),
  };
}

const RUN_SELECT = `SELECT s.* FROM reminder_schedules s
  JOIN reminders r ON r.id = s.reminder_id
  WHERE s.enabled = 1 AND r.enabled = 1`;

export function listRunSchedules(db: Database.Database): RunSchedule[] {
  const rows = db.prepare(RUN_SELECT).all() as ScheduleRow[];
  const textStmt = db.prepare("SELECT text FROM reminders WHERE id=?");
  return rows.map((r) => ({
    schedule: scheduleToLike(r),
    text: (textStmt.get(r.reminder_id) as { text: string } | undefined)?.text ?? "",
  }));
}

export type RetryDueSchedule = {
  schedule: import("./schedules").ScheduleLike;
  text: string;
  scheduledAt: number;
  catchup: boolean;
  retryCount: number;
};

/** 取出到期重试的调度（retry_at ≤ now）；供 tick 在常规到期之外恢复投递。 */
export function listRetryDueSchedules(db: Database.Database, nowMs: number): RetryDueSchedule[] {
  const rows = db
    .prepare(`${RUN_SELECT} AND s.retry_at IS NOT NULL AND s.retry_at <= ?`)
    .all(new Date(nowMs).toISOString()) as ScheduleRow[];
  const textStmt = db.prepare("SELECT text FROM reminders WHERE id=?");
  return rows.map((r) => ({
    schedule: scheduleToLike(r),
    text: (textStmt.get(r.reminder_id) as { text: string } | undefined)?.text ?? "",
    scheduledAt: r.retry_scheduled_at ? Date.parse(r.retry_scheduled_at) : Date.now(),
    catchup: r.retry_catchup === 1,
    retryCount: r.retry_count,
  }));
}

/** 持久化 computeDue 的 updates（{id, next_at, sent, missed?}）；missed=true 记入 missed_at。 */
export function applyScheduleUpdates(db: Database.Database, updates: ScheduleUpdate[], nowMs = Date.now()): void {
  if (updates.length === 0) return;
  const nowIso = new Date(nowMs).toISOString();
  const apply = db.transaction(() => {
    for (const u of updates) {
      const missedIso =
        u.missed === true ? nowIso : u.missed && typeof u.missed === "object" ? new Date(u.missed.toMs).toISOString() : null;
      db.prepare("UPDATE reminder_schedules SET next_at=?, sent=?, missed_at=COALESCE(?, missed_at) WHERE id=?").run(
        u.next_at === null ? null : new Date(u.next_at).toISOString(),
        u.sent,
        missedIso,
        u.id,
      );
    }
  });
  apply.immediate();
}

/** 设置/清除投递重试状态（retry_at 为空即清除）。 */
export function setScheduleRetry(
  db: Database.Database,
  scheduleId: number,
  state: { retryAt: number | null; retryCount: number; scheduledAt: number; catchup: boolean } | null,
): void {
  if (state === null) {
    db.prepare("UPDATE reminder_schedules SET retry_at=NULL, retry_count=0, retry_scheduled_at=NULL, retry_catchup=0 WHERE id=?").run(scheduleId);
    return;
  }
  db.prepare(
    "UPDATE reminder_schedules SET retry_at=?, retry_count=?, retry_scheduled_at=?, retry_catchup=? WHERE id=?",
  ).run(
    state.retryAt === null ? null : new Date(state.retryAt).toISOString(),
    state.retryCount,
    new Date(state.scheduledAt).toISOString(),
    state.catchup ? 1 : 0,
    scheduleId,
  );
}

// —— 图片附件 ——

/** 保存一张图片：校验内容 → 写文件（排他创建）→ 登记行；超过上限或校验失败抛中文错误。 */
export function saveReminderImage(
  db: Database.Database,
  reminderId: number,
  data: Buffer,
  mime: string,
  originalName: string,
): ImageView {
  const ext = validateImage(data, mime);
  const exists = db.prepare("SELECT id FROM reminders WHERE id=?").get(reminderId) as { id: number } | undefined;
  if (!exists) throw new Error("提醒不存在或已删除");
  const countRow = db.prepare("SELECT COUNT(*) AS n FROM reminder_images WHERE reminder_id=?").get(reminderId) as { n: number };
  if (countRow.n >= REMINDERS_MAX_IMAGES) {
    throw new Error(`每条提醒最多 ${REMINDERS_MAX_IMAGES} 张图片`);
  }
  const dir = attachmentDir(reminderId);
  fs.mkdirSync(dir, { recursive: true });
  const storedName = `${Date.now().toString(36)}${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const target = path.join(dir, storedName);
  if (path.dirname(path.resolve(target)) !== path.resolve(dir)) throw new Error("附件文件不在存储目录内");
  const fd = fs.openSync(target, "wx");
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  try {
    const result = db
      .prepare("INSERT INTO reminder_images(reminder_id,stored_name,original_name,mime,size) VALUES(?,?,?,?,?)")
      .run(reminderId, storedName, (originalName ?? "").slice(0, 255) || storedName, mime, data.length);
    const row = db.prepare("SELECT * FROM reminder_images WHERE id=?").get(Number(result.lastInsertRowid)) as
      | Parameters<typeof rowToImage>[0]
      | undefined;
    if (!row) throw new Error("附件登记失败");
    return rowToImage(row);
  } catch (error) {
    try {
      fs.unlinkSync(target);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "保存图片失败，且文件清理失败");
    }
    throw error;
  }
}

/** 读取附件内容；文件名白名单校验 + 目录前缀校验（防路径穿越），不存在返回 null。 */
export function readReminderAttachment(reminderId: number, storedName: string): Buffer | null {
  if (!/^\d+$/.test(String(reminderId)) || !STORED_NAME_RE.test(storedName)) return null;
  const dir = path.resolve(attachmentDir(Number(reminderId)));
  const target = path.resolve(dir, storedName);
  if (!target.startsWith(dir + path.sep)) return null;
  try {
    return fs.readFileSync(target);
  } catch {
    return null;
  }
}

/** 删除一张附件（行 + 文件）；返回被删行（文件删除失败不回滚行删除，由调用方记录日志）。 */
export function deleteReminderImage(db: Database.Database, reminderId: number, imageId: number): ImageView | null {
  const row = db
    .prepare("SELECT * FROM reminder_images WHERE id=? AND reminder_id=?")
    .get(imageId, reminderId) as Parameters<typeof rowToImage>[0] | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM reminder_images WHERE id=?").run(imageId);
  const target = path.resolve(attachmentDir(reminderId), row.stored_name);
  const dir = path.resolve(attachmentDir(reminderId));
  if (target.startsWith(dir + path.sep)) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return rowToImage(row);
}

/** 删除提醒附件目录（删除提醒后调用；磁盘清理失败仅记录，不影响主流程）。 */
export function removeAttachmentDir(reminderId: number): void {
  const dir = path.resolve(attachmentDir(reminderId));
  if (!dir.startsWith(path.resolve(attachmentsRoot()) + path.sep)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error("提醒附件目录清理失败", error);
  }
}

export function isValidStoredImageName(name: string): boolean {
  return STORED_NAME_RE.test(name);
}

export function contentTypeOfImage(storedName: string): string {
  if (storedName.endsWith(".png")) return "image/png";
  if (storedName.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

// —— fire log ——

export function logFire(db: Database.Database, entry: FireLogEntry): void {
  db.prepare(
    "INSERT INTO reminder_fire_log(schedule_id,scheduled_at,attempted_at,status,detail,channel_results) VALUES(?,?,?,?,?,?)",
  ).run(
    entry.scheduleId,
    entry.scheduledAt,
    entry.attemptedAt ?? new Date().toISOString(),
    entry.status,
    entry.detail ?? "",
    JSON.stringify(entry.channelResults ?? []),
  );
}

export type FireLogView = {
  id: number;
  scheduleId: number;
  scheduledAt: string;
  attemptedAt: string;
  status: string;
  detail: string;
  channelResults: Array<{ name: string; status: string; error: string }>;
};

export function listFireLog(db: Database.Database, scheduleId?: number, limit = 200): FireLogView[] {
  const rows = (
    scheduleId !== undefined
      ? db.prepare("SELECT * FROM reminder_fire_log WHERE schedule_id=? ORDER BY id DESC LIMIT ?").all(scheduleId, limit)
      : db.prepare("SELECT * FROM reminder_fire_log ORDER BY id DESC LIMIT ?").all(limit)
  ) as Array<{
    id: number; schedule_id: number; scheduled_at: string; attempted_at: string; status: string; detail: string; channel_results: string;
  }>;
  return rows.map((r) => {
    let channels: FireLogView["channelResults"] = [];
    try {
      const parsed = JSON.parse(r.channel_results) as FireLogView["channelResults"];
      if (Array.isArray(parsed)) channels = parsed;
    } catch {
      channels = [];
    }
    return {
      id: r.id,
      scheduleId: r.schedule_id,
      scheduledAt: r.scheduled_at,
      attemptedAt: r.attempted_at,
      status: r.status,
      detail: r.detail,
      channelResults: channels,
    };
  });
}
