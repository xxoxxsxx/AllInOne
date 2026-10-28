// 照片文件存储：/data/travel/photos 下，文件名 = 随机 token + 扩展名（不含用户输入）。
// 上传内容由客户端压缩为 JPEG/WebP/PNG Blob，这里只做扩展名与文件名校验。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/data-dir";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function photoDir(): string {
  return path.join(dataDir(), "travel", "photos");
}

export function extFromMime(mime: string): string | null {
  return EXT_BY_MIME[mime] ?? null;
}

const FILENAME_RE = /^[a-z0-9]+\.(jpg|png|webp)$/;

export function isValidPhotoFilename(file: string): boolean {
  return FILENAME_RE.test(file);
}

export function contentTypeOf(file: string): string {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export function savePhotoFile(data: Buffer, mime: string): string {
  const ext = extFromMime(mime);
  if (!ext) throw new Error("不支持的图片格式（仅支持 JPEG/PNG/WebP）");
  if (data.length === 0) throw new Error("图片内容为空");
  if (data.length > 8 * 1024 * 1024) throw new Error("图片过大（压缩后仍超过 8MB）");
  const dir = photoDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(dir, file), data);
  return file;
}

export function readPhotoFile(file: string): Buffer | null {
  if (!isValidPhotoFilename(file)) return null;
  const p = path.join(photoDir(), file);
  if (!p.startsWith(photoDir() + path.sep)) return null;
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

export function removePhotoFile(file: string): void {
  if (!isValidPhotoFilename(file)) return;
  try {
    fs.unlinkSync(path.join(photoDir(), file));
  } catch {
    // 文件可能已不存在；忽略。
  }
}
