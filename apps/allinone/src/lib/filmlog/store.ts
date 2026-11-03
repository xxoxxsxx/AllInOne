// 胶卷日志 SQLite 存储：独立库文件 DATA_DIR/filmlog/filmlog.db（与提醒事项/证件夹等互不影响）。
// 结构：film_rolls（胶卷）→ film_images（冲扫图片附件，文件落盘 DATA_DIR/filmlog/attachments/<rollId>/）。
// 全部业务字段为字符串（相机/胶卷等自由输入，不建字典表）；日期 YYYY-MM-DD 或空串，
// 允许"不详"（空），仅做格式与日历合理性校验。状态推进（advanceRoll）按固定顺序
// stock → shooting → shot → developing → developed，只补填当前步骤对应的空日期，已有日期不覆盖。

import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/data-dir";

export const FILM_SCHEMA_VERSION = 2;
/** 每卷最多图片数。 */
export const MAX_IMAGES_PER_ROLL = 12;
/** 单张图片最大字节数（10MB）。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 单字段最大长度（自由文本 note 放宽）。 */
export const MAX_FIELD_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2000;

export const FILM_STATUSES = ["stock", "shooting", "shot", "developing", "developed"] as const;
export type FilmStatus = (typeof FILM_STATUSES)[number];

/** 状态推进顺序：下一步 = 当前索引 + 1；developed 已到终点。 */
const STATUS_ORDER: FilmStatus[] = ["stock", "shooting", "shot", "developing", "developed"];

/** 状态 → 推进到该状态时应补填的日期字段。 */
const DATE_FIELD_BY_STATUS: Record<FilmStatus, string | null> = {
  stock: null,
  shooting: "openedAt",
  shot: "finishedAt",
  developing: "sentAt",
  developed: "developedAt",
};

/** 允许的图片 MIME 与扩展名（文件头校验，见 validateImage，不信任客户端 MIME）。 */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STORED_NAME_RE = /^[a-z0-9]+\.(jpg|png|webp)$/;

export type FilmInput = {
  brand: string;
  film: string;
  iso: string;
  format: string;
  frames: string;
  batch: string;
  purchasedAt: string;
  expiresAt: string;
  openedAt: string;
  finishedAt: string;
  sentAt: string;
  developedAt: string;
  camera: string;
  process: string;
  lab: string;
  purchasePrice: string;
  developPrice: string;
  note: string;
  status: FilmStatus;
};

export type FilmImage = {
  id: number;
  filename: string;
  name: string;
  mime: string;
};

export type FilmRoll = FilmInput & {
  id: number;
  createdAt: string;
  updatedAt: string;
  images: FilmImage[];
};

const FILM_FIELDS = [
  "brand",
  "film",
  "iso",
  "format",
  "frames",
  "batch",
  "purchasedAt",
  "expiresAt",
  "openedAt",
  "finishedAt",
  "sentAt",
  "developedAt",
  "camera",
  "process",
  "lab",
  "purchasePrice",
  "developPrice",
  "note",
] as const;

declare global {
  var __filmlogSqlite: Database.Database | undefined;
}

// —— 路径 ——

export function filmlogRootDir(): string {
  return path.join(dataDir(), "filmlog");
}

export function filmlogDbPath(): string {
  return path.join(filmlogRootDir(), "filmlog.db");
}

export function attachmentsRoot(): string {
  return path.join(filmlogRootDir(), "attachments");
}

export function attachmentDir(rollId: number): string {
  if (!Number.isSafeInteger(rollId) || rollId < 1) throw new Error("胶卷编号无效");
  return path.join(attachmentsRoot(), String(rollId));
}

// —— 校验 ——

/** 日期 YYYY-MM-DD 或空串；空表示"不详/未填"，允许。校验真实日历（如 2 月 30 日拒绝）。 */
function validateDate(value: string, label: string): string {
  if (value === "") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`${label} 格式应为 YYYY-MM-DD 或留空`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) throw new Error(`${label} 不是有效日期`);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) throw new Error(`${label} 不是有效日期`);
  if (year < 1800 || year > 2200) throw new Error(`${label} 年份超出合理范围`);
  return value;
}

/** 相机/胶卷等自由文本：去首尾空白，限长。 */
function validateText(value: string, label: string, maxLength = MAX_FIELD_LENGTH): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > maxLength) throw new Error(`${label} 不能超过 ${maxLength} 个字符`);
  return text;
}

function validateStatus(status: string): FilmStatus {
  if (!(FILM_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`状态必须是 ${FILM_STATUSES.join("/")} 之一`);
  }
  return status as FilmStatus;
}

/** 校验图片内容与声明 MIME 一致（JPEG/PNG/WebP 真实文件头），返回扩展名。 */
export function validateImage(data: Buffer, mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error("不支持的图片格式（仅支持 JPG/PNG/WebP）");
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error("图片内容为空");
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`单张图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
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
  if (actualMime !== mime) throw new Error("图片内容与格式不符（仅支持真实 JPG/PNG/WebP 图片）");
  return ext;
}

/** 附件落盘文件名（随机 hex + 白名单扩展名）；readImage/deleteImage 均校验，防路径穿越。 */
export function isValidStoredImageName(name: string): boolean {
  return STORED_NAME_RE.test(name);
}

export function contentTypeOfImage(storedName: string): string | null {
  const ext = storedName.split(".").pop();
  const entry = Object.entries(EXT_BY_MIME).find(([, e]) => e === ext);
  return entry ? entry[0] : null;
}

// —— 打开 / 迁移 ——

export function openFilmDb(file?: string): Database.Database {
  const dbPath = file ?? filmlogDbPath();
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
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

export function getFilmDb(): Database.Database {
  if (!globalThis.__filmlogSqlite) {
    fs.mkdirSync(filmlogRootDir(), { recursive: true });
    globalThis.__filmlogSqlite = openFilmDb(filmlogDbPath());
  }
  return globalThis.__filmlogSqlite;
}

/** 测试专用：关闭并清空全局句柄（独立临时 DATA_DIR 用）。 */
export function resetFilmDbForTest(): void {
  const existing = globalThis.__filmlogSqlite;
  if (existing) {
    try {
      existing.close();
    } catch {
      // 已关闭则忽略。
    }
  }
  globalThis.__filmlogSqlite = undefined;
}

function migrate(db: Database.Database): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version >= FILM_SCHEMA_VERSION) return;
  if (version < 1) {
    db.exec(`
      CREATE TABLE film_rolls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand TEXT NOT NULL DEFAULT '',
        film TEXT NOT NULL DEFAULT '',
        iso TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL DEFAULT '',
        frames TEXT NOT NULL DEFAULT '',
        batch TEXT NOT NULL DEFAULT '',
        purchased_at TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL DEFAULT '',
        opened_at TEXT NOT NULL DEFAULT '',
        finished_at TEXT NOT NULL DEFAULT '',
        sent_at TEXT NOT NULL DEFAULT '',
        developed_at TEXT NOT NULL DEFAULT '',
        camera TEXT NOT NULL DEFAULT '',
        process TEXT NOT NULL DEFAULT '',
        lab TEXT NOT NULL DEFAULT '',
        purchase_price TEXT NOT NULL DEFAULT '',
        develop_price TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'stock',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE film_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roll_id INTEGER NOT NULL REFERENCES film_rolls(id) ON DELETE CASCADE,
        stored_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_film_images_roll ON film_images(roll_id);
    `);
    db.pragma("user_version = 1");
  }
  if (version < 2) {
    // 录入选项库：品牌/型号/规格/工艺等字段的自由输入可保存为下拉选项。
    db.exec(`
      CREATE TABLE IF NOT EXISTS film_options (
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (field, value)
      );
    `);
    db.pragma(`user_version = ${FILM_SCHEMA_VERSION}`);
  }
}

// —— 行映射 ——

type RollRow = {
  id: number;
  brand: string;
  film: string;
  iso: string;
  format: string;
  frames: string;
  batch: string;
  purchased_at: string;
  expires_at: string;
  opened_at: string;
  finished_at: string;
  sent_at: string;
  developed_at: string;
  camera: string;
  process: string;
  lab: string;
  purchase_price: string;
  develop_price: string;
  note: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type ImageRow = {
  id: number;
  roll_id: number;
  stored_name: string;
  original_name: string;
  mime: string;
  size: number;
  created_at: string;
};

function rowToImage(r: ImageRow): FilmImage {
  return { id: r.id, filename: r.stored_name, name: r.original_name, mime: r.mime };
}

function imagesOf(db: Database.Database, rollId: number): FilmImage[] {
  const rows = db
    .prepare("SELECT id, roll_id, stored_name, original_name, mime, size, created_at FROM film_images WHERE roll_id = ? ORDER BY id")
    .all(rollId) as ImageRow[];
  return rows.map(rowToImage);
}

function rowToRoll(db: Database.Database, r: RollRow): FilmRoll {
  return {
    id: r.id,
    brand: r.brand,
    film: r.film,
    iso: r.iso,
    format: r.format,
    frames: r.frames,
    batch: r.batch,
    purchasedAt: r.purchased_at,
    expiresAt: r.expires_at,
    openedAt: r.opened_at,
    finishedAt: r.finished_at,
    sentAt: r.sent_at,
    developedAt: r.developed_at,
    camera: r.camera,
    process: r.process,
    lab: r.lab,
    purchasePrice: r.purchase_price,
    developPrice: r.develop_price,
    note: r.note,
    status: r.status as FilmStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    images: imagesOf(db, r.id),
  };
}

// —— CRUD ——

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeInput(input: FilmInput): FilmInput {
  const normalized: FilmInput = {
    brand: validateText(input.brand, "胶卷品牌"),
    film: validateText(input.film, "胶卷型号"),
    iso: validateText(input.iso, "ISO"),
    format: validateText(input.format, "画幅"),
    frames: validateText(input.frames, "张数"),
    batch: validateText(input.batch, "批次"),
    purchasedAt: validateDate(input.purchasedAt ?? "", "购买日期"),
    expiresAt: validateDate(input.expiresAt ?? "", "过期日期"),
    openedAt: validateDate(input.openedAt ?? "", "开机日期"),
    finishedAt: validateDate(input.finishedAt ?? "", "拍完日期"),
    sentAt: validateDate(input.sentAt ?? "", "送冲日期"),
    developedAt: validateDate(input.developedAt ?? "", "冲扫完成日期"),
    camera: validateText(input.camera, "相机"),
    process: validateText(input.process, "冲扫工艺"),
    lab: validateText(input.lab, "冲扫店"),
    purchasePrice: validateText(input.purchasePrice, "购买价格"),
    developPrice: validateText(input.developPrice, "冲扫价格"),
    note: validateText(input.note ?? "", "备注", MAX_NOTE_LENGTH),
    status: validateStatus(input.status ?? "stock"),
  };
  if (!normalized.film) throw new Error("请输入胶卷型号");
  return normalized;
}

/**
 * 新建胶卷（id 省略或 undefined 时），返回新 id；传入 id 则更新该胶卷（含 status 编辑），返回该 id。
 */
export function saveRoll(db: Database.Database, input: FilmInput, id?: number): number {
  const data = normalizeInput(input);
  const now = nowIso();
  if (id === undefined) {
    const info = db
      .prepare(
        `INSERT INTO film_rolls
           (brand, film, iso, format, frames, batch, purchased_at, expires_at, opened_at, finished_at,
            sent_at, developed_at, camera, process, lab, purchase_price, develop_price, note, status,
            created_at, updated_at)
         VALUES (@brand, @film, @iso, @format, @frames, @batch, @purchasedAt, @expiresAt, @openedAt, @finishedAt,
                 @sentAt, @developedAt, @camera, @process, @lab, @purchasePrice, @developPrice, @note, @status,
                 @now, @now)`,
      )
      .run({ ...data, now });
    return Number(info.lastInsertRowid);
  }
  const existing = db.prepare("SELECT id FROM film_rolls WHERE id = ?").get(id);
  if (!existing) throw new Error(`胶卷 #${id} 不存在`);
  db.prepare(
    `UPDATE film_rolls SET
       brand = @brand, film = @film, iso = @iso, format = @format, frames = @frames, batch = @batch,
       purchased_at = @purchasedAt, expires_at = @expiresAt, opened_at = @openedAt, finished_at = @finishedAt,
       sent_at = @sentAt, developed_at = @developedAt, camera = @camera, process = @process, lab = @lab,
       purchase_price = @purchasePrice, develop_price = @developPrice, note = @note, status = @status,
       updated_at = @now
     WHERE id = @id`,
  ).run({ ...data, now, id });
  return id;
}

export function listRolls(db: Database.Database): FilmRoll[] {
  const rows = db.prepare("SELECT * FROM film_rolls ORDER BY id DESC").all() as RollRow[];
  return rows.map((r) => rowToRoll(db, r));
}

export function getRoll(db: Database.Database, id: number): FilmRoll | null {
  const row = db.prepare("SELECT * FROM film_rolls WHERE id = ?").get(id) as RollRow | undefined;
  return row ? rowToRoll(db, row) : null;
}

export function deleteRoll(db: Database.Database, id: number): void {
  attachmentDir(id); // 删除数据库记录前校验路径组件。
  db.prepare("DELETE FROM film_rolls WHERE id = ?").run(id);
  removeAttachmentDir(id);
}

/**
 * 状态推进：按 stock → shooting → shot → developing → developed 顺序前进一步，
 * 只补填进入新状态对应且尚未填写的日期（由前端按 Asia/Shanghai 传入 YYYY-MM-DD），
 * 已填日期不覆盖；已在 developed（终点）时不变。允许编辑状态请直接 saveRoll。
 */
export function advanceRoll(db: Database.Database, id: number, date: string): void {
  const roll = getRoll(db, id);
  if (!roll) throw new Error(`胶卷 #${id} 不存在`);
  const index = STATUS_ORDER.indexOf(roll.status);
  if (index < 0) throw new Error(`未知状态：${roll.status}`);
  const next = STATUS_ORDER[index + 1];
  if (!next) return; // 已到终点
  const field = DATE_FIELD_BY_STATUS[next];
  const updated: FilmRoll = { ...roll, status: next };
  if (field && !(roll[field as keyof FilmRoll] as string)) {
    (updated as unknown as Record<string, string>)[field] = date;
  }
  saveRoll(db, updated as FilmInput, id);
}

// —— 附件 ——

export function saveImage(db: Database.Database, id: number, data: Buffer, mime: string, name: string): number {
  const roll = db.prepare("SELECT id FROM film_rolls WHERE id = ?").get(id);
  if (!roll) throw new Error(`胶卷 #${id} 不存在`);
  const countRow = db.prepare("SELECT COUNT(*) AS n FROM film_images WHERE roll_id = ?").get(id) as { n: number } | undefined;
  if (Number(countRow?.n ?? 0) >= MAX_IMAGES_PER_ROLL) throw new Error(`每卷最多 ${MAX_IMAGES_PER_ROLL} 张图片`);
  const ext = validateImage(data, mime);
  const originalName = validateText(name ?? "", "图片名称", MAX_FIELD_LENGTH) || `image.${ext}`;
  const dir = attachmentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const storedName = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(dir, storedName), data, { flag: "wx" });
  try {
    const info = db
      .prepare(
        "INSERT INTO film_images (roll_id, stored_name, original_name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, storedName, originalName, mime, data.length, nowIso());
    return Number(info.lastInsertRowid);
  } catch (error) {
    try {
      fs.unlinkSync(path.join(dir, storedName));
    } catch {
      // 落盘清理失败则忽略（孤儿文件不影响数据一致性校验）。
    }
    throw error;
  }
}

export function deleteImage(db: Database.Database, id: number, imageId: number): void {
  const row = db
    .prepare("SELECT id, roll_id, stored_name FROM film_images WHERE id = ? AND roll_id = ?")
    .get(imageId, id) as { id: number; roll_id: number; stored_name: string } | undefined;
  if (!row) return;
  db.prepare("DELETE FROM film_images WHERE id = ?").run(imageId);
  if (isValidStoredImageName(row.stored_name)) {
    try {
      fs.unlinkSync(path.join(attachmentDir(id), row.stored_name));
    } catch {
      // 文件已不存在则忽略。
    }
  }
}

export function readImage(db: Database.Database, id: number, filename: string): { data: Buffer; mime: string } | null {
  if (!isValidStoredImageName(filename)) return null;
  const row = db
    .prepare("SELECT mime FROM film_images WHERE roll_id = ? AND stored_name = ?")
    .get(id, filename) as { mime: string } | undefined;
  if (!row) return null;
  const filePath = path.join(attachmentDir(id), filename);
  try {
    const data = fs.readFileSync(filePath);
    return { data, mime: row.mime };
  } catch {
    return null;
  }
}

export function removeAttachmentDir(rollId: number): void {
  const dir = attachmentDir(rollId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 目录不存在等情况下忽略。
  }
}

// —— 录入选项库（品牌/型号/规格/工艺等下拉预设 + 用户自存选项） ——

/** 支持下拉选项的字段（与表单字段同名）。 */
export const OPTION_FIELDS = ["brand", "film", "iso", "format", "process", "camera", "lab"] as const;
export type OptionField = (typeof OPTION_FIELDS)[number];

/** 常见预设（始终出现在下拉中）；用户保存的新选项存入 film_options 表。 */
export const FILM_PRESETS: Record<OptionField, string[]> = {
  brand: ["Kodak 柯达", "Fujifilm 富士", "Ilford 伊尔福", "Agfa 爱克发", "CineStill", "Lomography", "乐凯", "上海申光"],
  film: ["Portra 400", "Ektar 100", "Gold 200", "Ultramax 400", "Tri-X 400", "HP5 Plus", "Delta 3200", "Fuji C200", "Superia X-TRA 400", "Velvia 50", "Provia 100F", "CineStill 800T", "上海 GP3"],
  iso: ["50", "100", "125", "160", "200", "400", "800", "1600", "3200"],
  format: ["135", "120", "220", "110"],
  process: ["C-41 彩负", "E-6 反转", "黑白", "反转直冲", "自冲"],
  camera: [],
  lab: [],
};

export function isOptionField(field: string): field is OptionField {
  return (OPTION_FIELDS as readonly string[]).includes(field);
}

/** 合并预设与用户自存选项（去重、按本地规则排序）。 */
export function listOptions(db: Database.Database): Record<OptionField, string[]> {
  const rows = db.prepare("SELECT field,value FROM film_options").all() as Array<{ field: string; value: string }>;
  const out = {} as Record<OptionField, string[]>;
  for (const field of OPTION_FIELDS) {
    const custom = rows.filter((r) => r.field === field).map((r) => r.value);
    out[field] = [...new Set([...FILM_PRESETS[field], ...custom])].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }
  return out;
}

/** 保存用户自存选项：忽略已存在项（预设或已存），非法字段抛中文错误。 */
export function saveOptions(db: Database.Database, field: OptionField, values: string[]): void {
  if (!isOptionField(field)) throw new Error("选项字段无效");
  const now = nowIso();
  const insert = db.prepare("INSERT OR IGNORE INTO film_options(field,value,created_at) VALUES(?,?,?)");
  for (const raw of values) {
    const value = validateText(raw, "选项值");
    if (value === "") continue;
    if (FILM_PRESETS[field].includes(value)) continue;
    insert.run(field, value, now);
  }
}
