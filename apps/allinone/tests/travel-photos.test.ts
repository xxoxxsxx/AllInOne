import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addPlace, createTrip, openTravelDB } from "../src/lib/travel/db.ts";
import { uploadPlacePhotos } from "../src/lib/travel/photo-service.ts";
import {
  photoDir,
  readPhotoFile,
  removePhotoFile,
  removePhotoFiles,
  savePhotoFile,
} from "../src/lib/travel/photos.ts";

// Pillow 生成的 1×1 红色图片；保留完整有效编码，而非仅伪造魔数。
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
  "base64",
);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const WEBP = Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=", "base64");
const jpeg = () => ({ data: JPEG, mime: "image/jpeg" });

function withStorage(run: (ctx: {
  db: ReturnType<typeof openTravelDB>;
  placeId: number;
  diskFiles: () => string[];
  rowCount: () => number;
}) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "travel-photos-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  const db = openTravelDB(undefined, path.join(root, "travel.db"));
  try {
    const tripId = createTrip(db, { title: "照片回归测试" });
    const placeId = addPlace(db, tripId, null, "测试地点");
    run({
      db,
      placeId,
      diskFiles: () => fs.existsSync(photoDir()) ? fs.readdirSync(photoDir()).sort() : [],
      rowCount: () => (db.prepare("SELECT COUNT(*) AS n FROM place_photos").get() as { n: number }).n,
    });
  } finally {
    db.close();
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("travel-photos-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("upload persists real JPEG, PNG and WebP with matching rows and bytes", () => {
  withStorage(({ db, placeId, diskFiles, rowCount }) => {
    const inputs = [jpeg(), { data: PNG, mime: "image/png" }, { data: WEBP, mime: "image/webp" }];
    const photos = uploadPlacePhotos(db, placeId, inputs);
    assert.equal(photos.length, 3);
    assert.equal(rowCount(), 3);
    assert.deepEqual(diskFiles(), photos.map((p) => p.file).sort());
    photos.forEach((photo, i) => {
      assert.ok(photo.id > 0);
      assert.deepEqual(readPhotoFile(photo.file), inputs[i].data);
    });
    assert.deepEqual(photos.map((p) => path.extname(p.file)), [".jpg", ".png", ".webp"]);
  });
});

test("validates every image and MIME before writing any file or row", () => {
  withStorage(({ db, placeId, diskFiles, rowCount }) => {
    const bad = [
      { data: Buffer.from("fake-jpeg-bytes"), mime: "image/jpeg" },
      { data: PNG, mime: "image/jpeg" },
      { data: JPEG, mime: "image/png" },
      { data: WEBP, mime: "image/png" },
      { data: JPEG, mime: "image/gif" },
      { data: JPEG, mime: "toString" },
      { data: Buffer.alloc(0), mime: "image/jpeg" },
      { data: PNG.subarray(0, 7), mime: "image/png" },
      { data: JPEG.subarray(0, 2), mime: "image/jpeg" },
      { data: WEBP.subarray(0, 12), mime: "image/webp" },
    ];
    const wrongContainer = Buffer.from(WEBP);
    wrongContainer.write("WAVE", 8, "ascii");
    bad.push({ data: wrongContainer, mime: "image/webp" });
    const wrongSize = Buffer.from(WEBP);
    wrongSize.writeUInt32LE(0, 4);
    bad.push({ data: wrongSize, mime: "image/webp" });
    const highBitHeader = Buffer.from(WEBP);
    highBitHeader[0] |= 0x80;
    bad.push({ data: highBitHeader, mime: "image/webp" });
    for (const input of bad) {
      assert.throws(() => uploadPlacePhotos(db, placeId, [jpeg(), input]));
      assert.equal(rowCount(), 0);
      assert.deepEqual(diskFiles(), []);
      assert.equal(fs.existsSync(photoDir()), false);
    }
  });
});

test("missing place and invalid batch counts create no files or rows", () => {
  withStorage(({ db, placeId, diskFiles, rowCount }) => {
    assert.throws(() => uploadPlacePhotos(db, placeId + 100, [jpeg()]), /地点不存在/);
    assert.throws(() => uploadPlacePhotos(db, placeId, []), /请选择照片/);
    assert.throws(() => uploadPlacePhotos(db, placeId, Array.from({ length: 10 }, jpeg)), /每批最多.*9/);
    assert.equal(rowCount(), 0);
    assert.deepEqual(diskFiles(), []);
    assert.equal(fs.existsSync(photoDir()), false);
  });
});

test("place accepts exactly nine photos and rejects an entire batch exceeding capacity", () => {
  withStorage(({ db, placeId, diskFiles, rowCount }) => {
    uploadPlacePhotos(db, placeId, Array.from({ length: 8 }, jpeg));
    const before = diskFiles();
    assert.throws(() => uploadPlacePhotos(db, placeId, [jpeg(), jpeg()]), /每个地点最多.*9/);
    assert.equal(rowCount(), 8);
    assert.deepEqual(diskFiles(), before);
    uploadPlacePhotos(db, placeId, [jpeg()]);
    assert.equal(rowCount(), 9);
    assert.equal(diskFiles().length, 9);
    assert.throws(() => uploadPlacePhotos(db, placeId, [jpeg()]), /每个地点最多.*9/);
    assert.equal(rowCount(), 9);
    assert.equal(diskFiles().length, 9);
  });
});

test("batch total rejects over 10MB, accepts 10MB, and retains the 8MB single-file limit", () => {
  withStorage(({ db, placeId, diskFiles, rowCount }) => {
    // JPEG 解码允许 EOI 后填充，用真实图片加尾部字节测试边界。
    const sized = (bytes: number) => ({ data: Buffer.concat([JPEG, Buffer.alloc(bytes - JPEG.length)]), mime: "image/jpeg" });
    assert.throws(() => uploadPlacePhotos(db, placeId, [sized(8 * 1024 * 1024 + 1)]), /8MB/);
    assert.throws(() => uploadPlacePhotos(db, placeId, [sized(5 * 1024 * 1024), sized(5 * 1024 * 1024 + 1)]), /10MB/);
    assert.equal(rowCount(), 0);
    assert.deepEqual(diskFiles(), []);
    uploadPlacePhotos(db, placeId, [sized(5 * 1024 * 1024), sized(5 * 1024 * 1024)]);
    assert.equal(rowCount(), 2);
    assert.equal(diskFiles().length, 2);
  });
});

test("second database insert failure rolls back the whole batch and cleans only new files", () => {
  withStorage(({ db, placeId, diskFiles, rowCount }) => {
    const existing = uploadPlacePhotos(db, placeId, [jpeg()]);
    const before = diskFiles();
    db.exec(`CREATE TRIGGER fail_second_batch_photo BEFORE INSERT ON place_photos
      WHEN (SELECT COUNT(*) FROM place_photos) >= 2
      BEGIN SELECT RAISE(ABORT, 'injected photo insert failure'); END;`);
    assert.throws(() => uploadPlacePhotos(db, placeId, [jpeg(), jpeg()]), /injected photo insert failure/);
    assert.equal(rowCount(), 1);
    assert.deepEqual(diskFiles(), before);
    assert.deepEqual(readPhotoFile(existing[0].file), JPEG);
  });
});

test("partial second file write failure removes all new files without inserting rows", (t) => {
  withStorage(({ db, placeId, diskFiles, rowCount }) => {
    uploadPlacePhotos(db, placeId, [jpeg()]);
    const before = diskFiles();
    const original = fs.writeFileSync;
    let calls = 0;
    const mocked = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      calls += 1;
      if (calls === 2) {
        // 实际创建并部分写入第二个文件，再模拟磁盘写入错误。
        original(args[0], JPEG.subarray(0, 20));
        throw Object.assign(new Error("injected disk failure"), { code: "ENOSPC" });
      }
      return original(...args);
    });
    try {
      assert.throws(() => uploadPlacePhotos(db, placeId, [jpeg(), jpeg()]), /injected disk failure/);
    } finally {
      mocked.mock.restore();
    }
    assert.equal(rowCount(), 1);
    assert.deepEqual(diskFiles(), before);
  });
});

test("removePhotoFile restricts names, ignores ENOENT and propagates other filesystem errors", () => {
  withStorage(() => {
    const file = savePhotoFile(PNG, "image/png");
    assert.ok(path.isAbsolute(photoDir()));
    for (const invalid of ["../outside.jpg", path.join(photoDir(), file), "a/b.jpg", "a.gif", "a.jpg\n", ""]) {
      assert.throws(() => removePhotoFile(invalid), /文件名/);
    }
    assert.deepEqual(readPhotoFile(file), PNG);
    removePhotoFile(file);
    assert.equal(readPhotoFile(file), null);
    assert.doesNotThrow(() => removePhotoFile(file));
    fs.mkdirSync(path.join(photoDir(), "directory.jpg"));
    assert.throws(() => removePhotoFile("directory.jpg"), (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
  });
});

test("removePhotoFiles attempts every file and reports cleanup failures", () => {
  withStorage(() => {
    const file = savePhotoFile(WEBP, "image/webp");
    fs.mkdirSync(path.join(photoDir(), "directory.jpg"));
    assert.throws(() => removePhotoFiles(["directory.jpg", file, "missing.jpg"]), AggregateError);
    assert.equal(readPhotoFile(file), null);
    assert.doesNotThrow(() => removePhotoFiles([file, "missing.jpg"]));
  });
});
