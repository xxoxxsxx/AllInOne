// 证件夹 SQLite 存储：独立库文件 data/documents/documents.db（与 travel/台账互不影响）。
// 结构：documents（证件）→ document_tags / document_files；holders（持有人）、categories（分类）、tags（标签）。
// 有效期模型：expiry_type = date（直接填到期日）或 duration（开始日期 + 时长，写入时折算出 expiry_date）。

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/data-dir";
import { addDuration, statusOf, todayStr, type DocStatus } from "./constants";

export { EXPIRY_WARN_DAYS, MAX_FILES_PER_DOCUMENT } from "./constants";
export { addDuration, statusOf, todayStr } from "./constants";
export type { DocStatus } from "./constants";

export const DOCUMENTS_SCHEMA_VERSION = 2;
export const DEFAULT_CATEGORIES = ["护照", "签证", "身份证", "驾照", "社保", "保单", "合同", "其他"] as const;

export type DurationUnit = "day" | "month" | "year";

export type DocumentFile = {
  id: number;
  file: string;
  name: string;
  mime: string;
  size: number;
  isImage: boolean;
};

export type DocTag = { id: number; name: string };

export type DocumentRecord = {
  id: number;
  holderId: number | null;
  holderName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  title: string;
  number: string;
  issuer: string;
  startDate: string;
  expiryDate: string;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  note: string;
  tags: DocTag[];
  files: DocumentFile[];
  status: DocStatus;
  daysLeft: number | null;
  createdAt: string;
  updatedAt: string;
};

export type Holder = { id: number; name: string };
export type Category = { id: number; name: string };

export type DocumentInput = {
  holderId?: number | null;
  categoryId?: number | null;
  title: string;
  number?: string;
  issuer?: string;
  startDate?: string;
  expiryType: "date" | "duration";
  expiryDate?: string;
  durationValue?: number;
  durationUnit?: DurationUnit;
  note?: string;
  tags?: string[];
};

export type DocumentsSummary = { total: number; expiring: number; expired: number };

declare global {
  var __documentsSqlite: Database.Database | undefined;
}

function defaultDbPath(): string {
  return path.join(dataDir(), "documents", "documents.db");
}

export function openDocumentsDB(dir?: string, file = ":memory:"): Database.Database {
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

export function getDocumentsDB(): Database.Database {
  if (!globalThis.__documentsSqlite) {
    globalThis.__documentsSqlite = openDocumentsDB(undefined, defaultDbPath());
  }
  return globalThis.__documentsSqlite;
}

function migrate(db: Database.Database): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version > DOCUMENTS_SCHEMA_VERSION) {
    throw new Error(`documents.db schema 版本过高（${version} > ${DOCUMENTS_SCHEMA_VERSION}），请升级程序。`);
  }
  if (version === DOCUMENTS_SCHEMA_VERSION) return;
  if (version < 1) {
    db.exec(`
      CREATE TABLE holders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        holder_id INTEGER REFERENCES holders(id) ON DELETE SET NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        number TEXT NOT NULL DEFAULT '',
        issuer TEXT NOT NULL DEFAULT '',
        start_date TEXT NOT NULL DEFAULT '',
        expiry_date TEXT NOT NULL DEFAULT '',
        duration_value INTEGER,
        duration_unit TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE document_tags (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (document_id, tag_id)
      );
      CREATE TABLE document_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        file TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        is_image INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_documents_expiry ON documents(expiry_date);
      CREATE INDEX idx_document_tags_tag ON document_tags(tag_id);
      CREATE INDEX idx_document_files_doc ON document_files(document_id, sort_order);
    `);
    const at = now();
    const insertCategory = db.prepare(`INSERT INTO categories(name,sort_order,created_at) VALUES(?,?,?)`);
    DEFAULT_CATEGORIES.forEach((name, i) => insertCategory.run(name, i, at));
  }
  if (version < 2) {
    // v2：自由排序。既有数据按创建顺序初始化；新建证件排到末尾。
    db.exec(`ALTER TABLE documents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
      UPDATE documents SET sort_order = id;
      CREATE INDEX idx_documents_order ON documents(sort_order);`);
  }
  db.pragma(`user_version = ${DOCUMENTS_SCHEMA_VERSION}`);
}

// —— 校验工具 ——

function textField(value: string, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`${label}最多 ${max} 个字符`);
  return value.trim();
}

function dateField(value: string, label: string, required: boolean): string {
  const date = textField(value, label, 10);
  if (!date) {
    if (required) throw new Error(`${label}不能为空`);
    return "";
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000-") || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label}无效，请输入真实日期`);
  }
  return date;
}

function now(): string {
  return new Date().toISOString();
}

function computeExpiry(input: DocumentInput): string {
  if (input.expiryType === "duration") {
    const value = input.durationValue;
    const unit = input.durationUnit;
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("有效期时长必须为正整数");
    if (unit !== "day" && unit !== "month" && unit !== "year") throw new Error("有效期单位无效");
    const startDate = dateField(input.startDate ?? "", "开始日期", true);
    const maxDays = unit === "day" ? 3650 : unit === "month" ? 1200 : 100;
    if ((value as number) > maxDays) throw new Error(`有效期时长过大（最多 ${maxDays} ${unit === "day" ? "天" : unit === "month" ? "月" : "年"}）`);
    return dateField(addDuration(startDate, value as number, unit), "计算出的失效时间", true);
  }
  if (input.expiryType !== "date") throw new Error("有效期方式无效");
  const startDate = dateField(input.startDate ?? "", "开始日期", false);
  const expiryDate = dateField(input.expiryDate ?? "", "失效时间", false);
  if (startDate && expiryDate && expiryDate < startDate) throw new Error("失效时间不能早于开始日期");
  return expiryDate;
}

// —— 查询 ——

function loadTags(db: Database.Database, docIds: number[]): Map<number, DocTag[]> {
  const map = new Map<number, DocTag[]>();
  if (docIds.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT dt.document_id AS document_id, t.id AS id, t.name AS name
       FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
       WHERE dt.document_id IN (${docIds.map(() => "?").join(",")})
       ORDER BY t.name`,
    )
    .all(...docIds) as Array<{ document_id: number; id: number; name: string }>;
  for (const r of rows) {
    const list = map.get(r.document_id) ?? [];
    list.push({ id: r.id, name: r.name });
    map.set(r.document_id, list);
  }
  return map;
}

function loadFiles(db: Database.Database, docIds: number[]): Map<number, DocumentFile[]> {
  const map = new Map<number, DocumentFile[]>();
  if (docIds.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT id,document_id,file,name,mime,size,is_image FROM document_files
       WHERE document_id IN (${docIds.map(() => "?").join(",")})
       ORDER BY sort_order,id`,
    )
    .all(...docIds) as Array<{ id: number; document_id: number; file: string; name: string; mime: string; size: number; is_image: number }>;
  for (const r of rows) {
    const list = map.get(r.document_id) ?? [];
    list.push({ id: r.id, file: r.file, name: r.name, mime: r.mime, size: r.size, isImage: r.is_image === 1 });
    map.set(r.document_id, list);
  }
  return map;
}

function rowToDocument(
  r: {
    id: number; holder_id: number | null; holder_name: string | null; category_id: number | null; category_name: string | null;
    title: string; number: string; issuer: string; start_date: string; expiry_date: string;
    duration_value: number | null; duration_unit: string | null; note: string; created_at: string; updated_at: string;
  },
  tags: Map<number, DocTag[]>,
  files: Map<number, DocumentFile[]>,
  today: string,
): DocumentRecord {
  const { status, daysLeft } = statusOf(r.expiry_date, today, r.start_date);
  return {
    id: r.id,
    holderId: r.holder_id,
    holderName: r.holder_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    title: r.title,
    number: r.number,
    issuer: r.issuer,
    startDate: r.start_date,
    expiryDate: r.expiry_date,
    durationValue: r.duration_value,
    durationUnit: (r.duration_unit as DurationUnit | null) ?? null,
    note: r.note,
    tags: tags.get(r.id) ?? [],
    files: files.get(r.id) ?? [],
    status,
    daysLeft,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const DOC_SELECT = `
  SELECT d.id, d.holder_id, h.name AS holder_name, d.category_id, c.name AS category_name,
         d.title, d.number, d.issuer, d.start_date, d.expiry_date,
         d.duration_value, d.duration_unit, d.note, d.created_at, d.updated_at
  FROM documents d
  LEFT JOIN holders h ON h.id = d.holder_id
  LEFT JOIN categories c ON c.id = d.category_id`;

export function listDocuments(db: Database.Database, today: string = todayStr()): DocumentRecord[] {
  const rows = db.prepare(`${DOC_SELECT} ORDER BY d.sort_order, d.id`).all() as Array<Parameters<typeof rowToDocument>[0]>;
  const tags = loadTags(db, rows.map((r) => r.id));
  const files = loadFiles(db, rows.map((r) => r.id));
  return rows.map((r) => rowToDocument(r, tags, files, today));
}

export function getDocument(db: Database.Database, docId: number, today: string = todayStr()): DocumentRecord | null {
  const r = db.prepare(`${DOC_SELECT} WHERE d.id=?`).get(docId) as Parameters<typeof rowToDocument>[0] | undefined;
  if (!r) return null;
  const tags = loadTags(db, [r.id]);
  const files = loadFiles(db, [r.id]);
  return rowToDocument(r, tags, files, today);
}

export function listHolders(db: Database.Database): Holder[] {
  return db.prepare(`SELECT id,name FROM holders ORDER BY name`).all() as Holder[];
}

export function listCategories(db: Database.Database): Category[] {
  return db.prepare(`SELECT id,name FROM categories ORDER BY sort_order,id`).all() as Category[];
}

export function listTags(db: Database.Database): DocTag[] {
  return db.prepare(`SELECT id,name FROM tags ORDER BY name`).all() as DocTag[];
}

export function documentsSummary(db: Database.Database, today: string = todayStr()): DocumentsSummary {
  const docs = db.prepare(`SELECT start_date,expiry_date FROM documents`).all() as Array<{ start_date: string; expiry_date: string }>;
  let expiring = 0;
  let expired = 0;
  for (const d of docs) {
    const { status } = statusOf(d.expiry_date, today, d.start_date);
    if (status === "expiring") expiring += 1;
    if (status === "expired") expired += 1;
  }
  return { total: docs.length, expiring, expired };
}

// —— 变更 ——

function upsertTags(db: Database.Database, docId: number, names: string[]): void {
  if (!Array.isArray(names) || names.length > 20) throw new Error("每份证件最多 20 个标签");
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of names) {
    const name = textField(raw, "标签", 40);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    cleaned.push(name);
  }
  db.prepare(`DELETE FROM document_tags WHERE document_id=?`).run(docId);
  for (const name of cleaned) {
    db.prepare(`INSERT INTO tags(name,created_at) VALUES(?,?) ON CONFLICT(name) DO NOTHING`).run(name, now());
    const tag = db.prepare(`SELECT id FROM tags WHERE name=?`).get(name) as { id: number };
    db.prepare(`INSERT OR IGNORE INTO document_tags(document_id,tag_id) VALUES(?,?)`).run(docId, tag.id);
  }
}

function validateRefs(db: Database.Database, holderId: number | null, categoryId: number | null): void {
  if (holderId !== null && !db.prepare(`SELECT id FROM holders WHERE id=?`).get(holderId)) {
    throw new Error("持有人不存在");
  }
  if (categoryId !== null && !db.prepare(`SELECT id FROM categories WHERE id=?`).get(categoryId)) {
    throw new Error("分类不存在");
  }
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("参数无效");
  return n;
}

export function createDocument(db: Database.Database, input: DocumentInput): number {
  const title = textField(input.title, "证件名称", 100);
  if (!title) throw new Error("证件名称不能为空");
  const holderId = input.holderId === undefined ? null : intOrNull(input.holderId);
  const categoryId = input.categoryId === undefined ? null : intOrNull(input.categoryId);
  validateRefs(db, holderId, categoryId);
  const expiryDate = computeExpiry(input);
  const at = now();
  return db.transaction(() => {
    const sortOrder = Number(
      (db.prepare(`SELECT COALESCE(MAX(sort_order),0)+1 AS s FROM documents`).get() as { s: number }).s,
    );
    const res = db
      .prepare(
        `INSERT INTO documents(holder_id,category_id,title,number,issuer,start_date,expiry_date,duration_value,duration_unit,note,sort_order,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        holderId, categoryId, title,
        textField(input.number ?? "", "证件号码", 64),
        textField(input.issuer ?? "", "签发机关", 100),
        dateField(input.startDate ?? "", "开始日期", false),
        expiryDate,
        input.expiryType === "duration" ? (input.durationValue as number) : null,
        input.expiryType === "duration" ? (input.durationUnit as string) : null,
        textField(input.note ?? "", "备注", 2000),
        sortOrder,
        at, at,
      );
    const docId = Number(res.lastInsertRowid);
    if (input.tags) upsertTags(db, docId, input.tags);
    return docId;
  }).immediate();
}

export function updateDocument(db: Database.Database, docId: number, input: DocumentInput): void {
  const cur = db.prepare(`SELECT id FROM documents WHERE id=?`).get(docId);
  if (!cur) throw new Error("证件不存在");
  const title = textField(input.title, "证件名称", 100);
  if (!title) throw new Error("证件名称不能为空");
  const holderId = input.holderId === undefined ? null : intOrNull(input.holderId);
  const categoryId = input.categoryId === undefined ? null : intOrNull(input.categoryId);
  validateRefs(db, holderId, categoryId);
  const expiryDate = computeExpiry(input);
  db.transaction(() => {
    db.prepare(
      `UPDATE documents SET holder_id=?,category_id=?,title=?,number=?,issuer=?,start_date=?,expiry_date=?,
        duration_value=?,duration_unit=?,note=?,updated_at=? WHERE id=?`,
    ).run(
      holderId, categoryId, title,
      textField(input.number ?? "", "证件号码", 64),
      textField(input.issuer ?? "", "签发机关", 100),
      dateField(input.startDate ?? "", "开始日期", false),
      expiryDate,
      input.expiryType === "duration" ? (input.durationValue as number) : null,
      input.expiryType === "duration" ? (input.durationUnit as string) : null,
      textField(input.note ?? "", "备注", 2000),
      now(), docId,
    );
    if (input.tags) upsertTags(db, docId, input.tags);
  })();
}

export function deleteDocument(db: Database.Database, docId: number): string[] {
  return db.transaction(() => {
    const files = db.prepare(`SELECT file FROM document_files WHERE document_id=?`).all(docId) as Array<{ file: string }>;
    db.prepare(`DELETE FROM documents WHERE id=?`).run(docId);
    return files.map((f) => f.file);
  })();
}

// —— 自由排序 ——

/** 持有写锁时校验完整排列，避免排序和新增/删除交错。 */
export function reorderDocuments(db: Database.Database, orderedIds: number[]): void {
  db.transaction(() => {
    const current = db.prepare(`SELECT id FROM documents`).all() as Array<{ id: number }>;
    const currentIds = new Set(current.map((r) => r.id));
    const orderedSet = new Set(orderedIds);
    if (orderedIds.length !== currentIds.size || orderedSet.size !== currentIds.size || !orderedIds.every((id) => currentIds.has(id))) {
      throw new Error("排序数据与证件列表不一致，请刷新后重试");
    }
    const stmt = db.prepare(`UPDATE documents SET sort_order=? WHERE id=?`);
    orderedIds.forEach((id, i) => stmt.run(i, id));
  }).immediate();
}

// —— 持有人 ——

export function createHolder(db: Database.Database, name: string): number {
  const n = textField(name, "持有人姓名", 40);
  if (!n) throw new Error("持有人姓名不能为空");
  const dup = db.prepare(`SELECT id FROM holders WHERE name=?`).get(n);
  if (dup) throw new Error("持有人已存在");
  const res = db.prepare(`INSERT INTO holders(name,created_at) VALUES(?,?)`).run(n, now());
  return Number(res.lastInsertRowid);
}

export function renameHolder(db: Database.Database, holderId: number, name: string): void {
  const n = textField(name, "持有人姓名", 40);
  if (!n) throw new Error("持有人姓名不能为空");
  if (!db.prepare(`SELECT id FROM holders WHERE id=?`).get(holderId)) throw new Error("持有人不存在");
  if (db.prepare(`SELECT id FROM holders WHERE name=? AND id<>?`).get(n, holderId)) throw new Error("持有人已存在");
  db.prepare(`UPDATE holders SET name=? WHERE id=?`).run(n, holderId);
}

export function deleteHolder(db: Database.Database, holderId: number): void {
  // 证件保留（holder_id ON DELETE SET NULL → 未指定持有人）。
  db.prepare(`DELETE FROM holders WHERE id=?`).run(holderId);
}

// —— 分类 ——

export function createCategory(db: Database.Database, name: string): number {
  const n = textField(name, "分类名称", 40);
  if (!n) throw new Error("分类名称不能为空");
  const dup = db.prepare(`SELECT id FROM categories WHERE name=?`).get(n);
  if (dup) throw new Error("分类已存在");
  const max = Number((db.prepare(`SELECT COALESCE(MAX(sort_order),-1) AS m FROM categories`).get() as { m: number }).m);
  const res = db.prepare(`INSERT INTO categories(name,sort_order,created_at) VALUES(?,?,?)`).run(n, max + 1, now());
  return Number(res.lastInsertRowid);
}

export function renameCategory(db: Database.Database, categoryId: number, name: string): void {
  const n = textField(name, "分类名称", 40);
  if (!n) throw new Error("分类名称不能为空");
  if (!db.prepare(`SELECT id FROM categories WHERE id=?`).get(categoryId)) throw new Error("分类不存在");
  if (db.prepare(`SELECT id FROM categories WHERE name=? AND id<>?`).get(n, categoryId)) throw new Error("分类已存在");
  db.prepare(`UPDATE categories SET name=? WHERE id=?`).run(n, categoryId);
}

export function deleteCategory(db: Database.Database, categoryId: number): void {
  // 分类下的证件保留（category_id ON DELETE SET NULL → 未分类）。
  db.prepare(`DELETE FROM categories WHERE id=?`).run(categoryId);
}

// —— 标签 ——

export function deleteTag(db: Database.Database, tagId: number): void {
  db.prepare(`DELETE FROM tags WHERE id=?`).run(tagId);
}

// —— 附件行（文件由 files 服务管理） ——

export function addDocumentFileRow(db: Database.Database, docId: number, file: { file: string; name: string; mime: string; size: number; isImage: boolean }): number {
  if (!db.prepare(`SELECT id FROM documents WHERE id=?`).get(docId)) throw new Error("证件不存在");
  const sortOrder = Number(
    (db.prepare(`SELECT COALESCE(MAX(sort_order),-1)+1 AS s FROM document_files WHERE document_id=?`).get(docId) as { s: number }).s,
  );
  const res = db
    .prepare(`INSERT INTO document_files(document_id,file,name,mime,size,is_image,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(docId, file.file, file.name, file.mime, file.size, file.isImage ? 1 : 0, sortOrder, now());
  return Number(res.lastInsertRowid);
}

export function getDocumentFileRow(db: Database.Database, fileId: number): { id: number; documentId: number; file: string } | null {
  const r = db.prepare(`SELECT id,document_id,file FROM document_files WHERE id=?`).get(fileId) as
    | { id: number; document_id: number; file: string }
    | undefined;
  return r ? { id: r.id, documentId: r.document_id, file: r.file } : null;
}

export function deleteDocumentFileRow(db: Database.Database, fileId: number): string | null {
  const row = db.prepare(`SELECT file FROM document_files WHERE id=?`).get(fileId) as { file: string } | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM document_files WHERE id=?`).run(fileId);
  return row.file;
}
