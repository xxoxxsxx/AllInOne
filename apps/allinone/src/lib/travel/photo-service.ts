import type Database from "better-sqlite3";

import { addPhotoRow, type PlacePhoto } from "./db";
import { removePhotoFiles, savePhotoFile, validatePhoto } from "./photos";

const MAX_PHOTOS = 9;
const MAX_BATCH_BYTES = 10 * 1024 * 1024;

function validatePlaceCapacity(db: Database.Database, placeId: number, count: number): void {
  if (!db.prepare("SELECT id FROM places WHERE id=?").get(placeId)) {
    throw new Error("地点不存在");
  }
  const existing = (db.prepare("SELECT COUNT(*) AS n FROM place_photos WHERE place_id=?").get(placeId) as { n: number }).n;
  if (existing + count > MAX_PHOTOS) throw new Error("每个地点最多上传 9 张照片");
}

/** 同步批量上传：先整批校验，写文件后以单个事务插入；失败清理本次全部文件。 */
export function uploadPlacePhotos(
  db: Database.Database,
  placeId: number,
  files: Array<{ data: Buffer; mime: string }>,
): PlacePhoto[] {
  if (files.length === 0) throw new Error("请选择照片");
  if (files.length > MAX_PHOTOS) throw new Error("每批最多上传 9 张照片");
  validatePlaceCapacity(db, placeId, files.length);
  let bytes = 0;
  for (const { data, mime } of files) {
    validatePhoto(data, mime);
    bytes += data.length;
  }
  if (bytes > MAX_BATCH_BYTES) throw new Error("每批照片总大小不能超过 10MB");

  const saved: string[] = [];
  try {
    for (const { data, mime } of files) saved.push(savePhotoFile(data, mime));
    return db.transaction(() => {
      // 写文件后再次检查；立即事务锁防止其他数据库连接并发突破上限。
      validatePlaceCapacity(db, placeId, saved.length);
      return saved.map((file) => ({ id: addPhotoRow(db, placeId, file), file }));
    }).immediate();
  } catch (error) {
    try {
      removePhotoFiles(saved);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "上传照片失败，且文件清理失败");
    }
    throw error;
  }
}
