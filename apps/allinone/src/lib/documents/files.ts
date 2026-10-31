// 证件附件存储：随机文件名 + 白名单扩展名；图片按文件头校验，PDF 按 %PDF 头校验。
// 图片走预览/灯箱，PDF 与图片都支持内联查看；存储目录 data/documents/files。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { dataDir } from "@/lib/data-dir";
import { addDocumentFileRow, MAX_FILES_PER_DOCUMENT, type DocumentFile } from "./db";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BATCH_BYTES = 30 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILENAME_RE = /^[a-z0-9]+\.(jpg|png|webp|pdf)$/;

export function documentsFileDir(): string {
  return path.join(dataDir(), "documents", "files");
}

export function extFromMime(mime: string): string | null {
  return Object.hasOwn(EXT_BY_MIME, mime) ? EXT_BY_MIME[mime] : null;
}

export function isValidDocumentFilename(file: string): boolean {
  return typeof file === "string" && file === file.trim() && FILENAME_RE.test(file);
}

export function contentTypeOf(file: string): string {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".pdf")) return "application/pdf";
  return "image/jpeg";
}

/** 校验文件内容与声明 MIME 一致（文件头检测，不信任客户端 MIME）。 */
export function validateFile(data: Buffer, mime: string): void {
  if (!extFromMime(mime)) throw new Error("不支持的文件格式（仅支持 JPEG/PNG/WebP 图片与 PDF）");
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error("文件内容为空");
  if (data.length > MAX_FILE_BYTES) throw new Error(`单个文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024}MB`);

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
  } else if (data.toString("latin1", 0, 5) === "%PDF-") {
    actualMime = "application/pdf";
  }
  if (actualMime !== mime) throw new Error("文件内容与格式不符（仅支持真实 JPEG/PNG/WebP 图片与 PDF）");
}

function filePath(file: string): string {
  if (!isValidDocumentFilename(file)) throw new Error("无效的附件文件名");
  const dir = documentsFileDir();
  if (!path.isAbsolute(dir)) throw new Error("附件目录必须是绝对路径");
  const target = path.resolve(dir, file);
  if (path.dirname(target) !== path.resolve(dir)) throw new Error("附件文件不在存储目录内");
  return target;
}

export function saveDocumentFile(data: Buffer, mime: string): string {
  validateFile(data, mime);
  const ext = extFromMime(mime)!;
  const dir = documentsFileDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now().toString(36)}${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const target = filePath(file);
  // 排他创建：绝不覆盖已有文件；写入失败时清理本次创建的文件。
  const fd = fs.openSync(target, "wx");
  try {
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    try {
      removeDocumentFile(file);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "保存附件失败，且文件清理失败");
    }
    throw error;
  }
  return file;
}

export function readDocumentFile(file: string): Buffer | null {
  if (!isValidDocumentFilename(file)) return null;
  try {
    return fs.readFileSync(filePath(file));
  } catch {
    return null;
  }
}

export function removeDocumentFile(file: string): void {
  const target = filePath(file);
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** 尽量清理全部文件，并向调用方报告任何非 ENOENT 错误。 */
export function removeDocumentFiles(files: readonly string[]): void {
  const errors: unknown[] = [];
  for (const file of files) {
    try {
      removeDocumentFile(file);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "部分附件文件清理失败");
}

/** 附件原始文件名白名单化：保留可读名称，去掉路径与控制字符。 */
export function sanitizeOriginalName(raw: string | undefined): string {
  const name = String(raw ?? "").replace(/[\\/\u0000-\u001f]/g, "").trim();
  return name.slice(0, 120);
}

function validateDocCapacity(db: Database.Database, docId: number, count: number): void {
  if (!db.prepare("SELECT id FROM documents WHERE id=?").get(docId)) {
    throw new Error("证件不存在");
  }
  const existing = (db.prepare("SELECT COUNT(*) AS n FROM document_files WHERE document_id=?").get(docId) as { n: number }).n;
  if (existing + count > MAX_FILES_PER_DOCUMENT) throw new Error(`每份证件最多上传 ${MAX_FILES_PER_DOCUMENT} 个附件`);
}

/** 同步批量上传：先整批校验，写文件后以单个事务插入；失败清理本次全部文件。 */
export function uploadDocumentFiles(
  db: Database.Database,
  docId: number,
  files: Array<{ data: Buffer; mime: string; name?: string }>,
): DocumentFile[] {
  if (files.length === 0) throw new Error("请选择附件");
  if (files.length > MAX_FILES_PER_DOCUMENT) throw new Error(`每批最多上传 ${MAX_FILES_PER_DOCUMENT} 个附件`);
  validateDocCapacity(db, docId, files.length);
  let bytes = 0;
  for (const { data, mime } of files) {
    validateFile(data, mime);
    bytes += data.length;
  }
  if (bytes > MAX_BATCH_BYTES) throw new Error(`每批附件总大小不能超过 ${MAX_BATCH_BYTES / 1024 / 1024}MB`);

  const saved: Array<{ file: string; name: string; mime: string; size: number; isImage: boolean }> = [];
  try {
    for (const { data, mime, name } of files) {
      saved.push({
        file: saveDocumentFile(data, mime),
        name: sanitizeOriginalName(name ?? ""),
        mime,
        size: data.length,
        isImage: mime !== "application/pdf",
      });
    }
    return db.transaction(() => {
      // 写文件后再次检查；立即事务锁防止其他数据库连接并发突破上限。
      validateDocCapacity(db, docId, saved.length);
      return saved.map((f) => ({ id: addDocumentFileRow(db, docId, f), ...f }));
    }).immediate();
  } catch (error) {
    try {
      removeDocumentFiles(saved.map((f) => f.file));
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "上传附件失败，且文件清理失败");
    }
    throw error;
  }
}
