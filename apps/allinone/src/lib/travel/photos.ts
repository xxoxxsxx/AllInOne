// 照片文件存储：随机文件名，MIME 必须与 JPEG/PNG/WebP 文件头一致。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/data-dir";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILENAME_RE = /^[a-z0-9]+\.(jpg|png|webp)$/;

export function photoDir(): string {
  return path.join(dataDir(), "travel", "photos");
}

export function extFromMime(mime: string): string | null {
  return Object.hasOwn(EXT_BY_MIME, mime) ? EXT_BY_MIME[mime] : null;
}

export function isValidPhotoFilename(file: string): boolean {
  return typeof file === "string" && file === file.trim() && FILENAME_RE.test(file);
}

export function contentTypeOf(file: string): string {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

/** 校验文件头而非信任客户端 MIME；在批量写入前也可单独调用。 */
export function validatePhoto(data: Buffer, mime: string): void {
  if (!extFromMime(mime)) throw new Error("不支持的图片格式（仅支持 JPEG/PNG/WebP）");
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error("图片内容为空");
  if (data.length > 8 * 1024 * 1024) throw new Error("图片过大（压缩后仍超过 8MB）");

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
}

function photoPath(file: string): string {
  if (!isValidPhotoFilename(file)) throw new Error("无效的照片文件名");
  const dir = photoDir();
  if (!path.isAbsolute(dir)) throw new Error("照片目录必须是绝对路径");
  const target = path.resolve(dir, file);
  if (path.dirname(target) !== path.resolve(dir)) throw new Error("照片文件不在存储目录内");
  return target;
}

export function savePhotoFile(data: Buffer, mime: string): string {
  validatePhoto(data, mime);
  const ext = extFromMime(mime)!;
  const dir = photoDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now().toString(36)}${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const target = photoPath(file);
  // 排他创建：绝不覆盖已有文件；即使写入中途失败，也清理本次创建的文件。
  const fd = fs.openSync(target, "wx");
  try {
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    try {
      removePhotoFile(file);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "保存照片失败，且文件清理失败");
    }
    throw error;
  }
  return file;
}

export function readPhotoFile(file: string): Buffer | null {
  if (!isValidPhotoFilename(file)) return null;
  try {
    return fs.readFileSync(photoPath(file));
  } catch {
    return null;
  }
}

export function removePhotoFile(file: string): void {
  const target = photoPath(file);
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** 尽量清理全部文件，并向调用方报告任何非 ENOENT 错误。 */
export function removePhotoFiles(files: readonly string[]): void {
  const errors: unknown[] = [];
  for (const file of files) {
    try {
      removePhotoFile(file);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "部分照片文件清理失败");
}
