import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  advanceRoll,
  attachmentDir,
  contentTypeOfImage,
  deleteImage,
  deleteRoll,
  FILM_STATUSES,
  filmlogDbPath,
  filmlogRootDir,
  getFilmDb,
  getRoll,
  isValidStoredImageName,
  listRolls,
  MAX_IMAGES_PER_ROLL,
  openFilmDb,
  readImage,
  resetFilmDbForTest,
  saveImage,
  saveRoll,
  validateImage,
} from "../src/lib/filmlog/store.ts";
import type { FilmInput } from "../src/lib/filmlog/store.ts";

// 图片校验按文件头判定：8 字节 PNG 签名 / 3 字节 JPEG 魔数 / RIFF-WEBP 头即可通过内容校验。
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  (() => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(16, 0);
    return b;
  })(),
  Buffer.from("WEBPVP8 ", "latin1"),
  Buffer.alloc(8),
]);
const FAKE_BYTES = Buffer.from("not an image at all............");

/** 独立临时 DATA_DIR（附件落盘用）+ 内存库；返回还原函数。 */
function withTempDataDir(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filmlog-store-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  return () => {
    resetFilmDbForTest();
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
}

function baseInput(overrides: Partial<FilmInput> = {}): FilmInput {
  return {
    brand: "Kodak",
    film: "Gold 200",
    iso: "200",
    format: "135",
    frames: "36",
    batch: "B2026",
    purchasedAt: "2026-01-15",
    expiresAt: "2028-06-30",
    openedAt: "",
    finishedAt: "",
    sentAt: "",
    developedAt: "",
    camera: "Nikon FM2",
    process: "C-41",
    lab: "",
    purchasePrice: "58",
    developPrice: "35",
    note: "",
    status: "stock",
    ...overrides,
  } as FilmInput;
}

test("saveRoll / getRoll / listRolls 基本存取", () => {
  const restore = withTempDataDir();
  try {
    const db = openFilmDb();
    const id = saveRoll(db, baseInput());
    const roll = getRoll(db, id);
    assert.ok(roll);
    assert.equal(roll.brand, "Kodak");
    assert.equal(roll.status, "stock");
    assert.equal(roll.purchasedAt, "2026-01-15");
    assert.deepEqual(roll.images, []);
    assert.match(roll.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    saveRoll(db, baseInput({ brand: "Fuji", status: "shooting" }), id);
    const updated = getRoll(db, id);
    assert.equal(updated?.brand, "Fuji");
    assert.equal(updated?.status, "shooting");
    saveRoll(db, baseInput({ note: "第二卷" }));
    assert.equal(listRolls(db).length, 2);
    assert.equal(getRoll(db, 999), null);
    assert.throws(() => saveRoll(db, baseInput(), 1234), /不存在/);
  } finally {
    restore();
  }
});

test("字段校验：状态枚举、日期格式与真实日历、文本长度", () => {
  const restore = withTempDataDir();
  try {
    const db = openFilmDb();
    assert.throws(() => saveRoll(db, baseInput({ film: "  " })), /胶卷型号/);
    assert.throws(() => saveRoll(db, baseInput({ status: "lost" as never })), /状态/);
    assert.throws(() => saveRoll(db, baseInput({ purchasedAt: "2026/01/15" })), /YYYY-MM-DD/);
    assert.throws(() => saveRoll(db, baseInput({ purchasedAt: "2026-02-30" })), /有效日期/);
    assert.throws(() => saveRoll(db, baseInput({ purchasedAt: "2026-13-01" })), /有效日期/);
    // 允许日期留空（"不详"），且 2 月 29 日闰年合法。
    const id = saveRoll(db, baseInput({ purchasedAt: "", expiresAt: "2028-02-29" }));
    assert.equal(getRoll(db, id)?.purchasedAt, "");
    // 自由输入的相机/胶卷信息不做字典限制，但限长。
    assert.throws(() => saveRoll(db, baseInput({ camera: "x".repeat(201) })), /超过/);
    const freeId = saveRoll(db, baseInput({ camera: "我爷爷的旧海鸥", film: "不知名分装卷" }));
    assert.equal(getRoll(db, freeId)?.camera, "我爷爷的旧海鸥");
  } finally {
    restore();
  }
});

test("advanceRoll 按顺序推进并只补填未填日期", () => {
  const restore = withTempDataDir();
  try {
    const db = openFilmDb();
    const id = saveRoll(db, baseInput({ openedAt: "2026-03-01" }));
    advanceRoll(db, id, "2026-03-10"); // stock → shooting，openedAt 已填，不覆盖
    assert.equal(getRoll(db, id)?.status, "shooting");
    assert.equal(getRoll(db, id)?.openedAt, "2026-03-01");
    advanceRoll(db, id, "2026-04-01"); // shooting → shot，补 finishedAt
    assert.equal(getRoll(db, id)?.finishedAt, "2026-04-01");
    advanceRoll(db, id, "2026-04-02"); // shot → developing，补 sentAt
    advanceRoll(db, id, "2026-04-09"); // developing → developed，补 developedAt
    const done = getRoll(db, id);
    assert.equal(done?.status, "developed");
    assert.equal(done?.developedAt, "2026-04-09");
    // 终点再推进：状态与日期均不变。
    advanceRoll(db, id, "2026-05-01");
    const still = getRoll(db, id);
    assert.equal(still?.status, "developed");
    assert.equal(still?.developedAt, "2026-04-09");
    assert.throws(() => advanceRoll(db, 999, "2026-01-01"), /不存在/);
  } finally {
    restore();
  }
});

test("saveImage / readImage / deleteImage：签名校验、数量与大小上限、路径安全", () => {
  const restore = withTempDataDir();
  try {
    const db = openFilmDb();
    const id = saveRoll(db, baseInput());
    const imageId = saveImage(db, id, PNG_BYTES, "image/png", "scan-01.png");
    assert.ok(imageId > 0);
    const roll = getRoll(db, id);
    assert.equal(roll?.images.length, 1);
    assert.equal(roll?.images[0].name, "scan-01.png");
    assert.equal(roll?.images[0].mime, "image/png");
    // 读取内容按库内 mime 返回。
    const read = readImage(db, id, roll!.images[0].filename);
    assert.ok(read);
    assert.deepEqual(read.data, PNG_BYTES);
    assert.equal(read.mime, "image/png");
    // 内容与 MIME 不符 / 伪图片 / 超大小 / 声明不支持格式。
    assert.throws(() => saveImage(db, id, PNG_BYTES, "image/jpeg", "a.jpg"), /不符/);
    assert.throws(() => saveImage(db, id, FAKE_BYTES, "image/png", "fake.png"), /真实/);
    assert.throws(() => saveImage(db, id, Buffer.alloc(MAX_IMAGES_PER_ROLL * 0 + 10 * 1024 * 1024 + 1), "image/png", "big.png"), /10MB/);
    assert.throws(() => saveImage(db, id, PNG_BYTES, "image/gif", "a.gif"), /支持/);
    // 最多 12 张。
    for (let i = 1; i < MAX_IMAGES_PER_ROLL; i += 1) {
      saveImage(db, id, JPEG_BYTES, "image/jpeg", `s-${i}.jpg`);
    }
    assert.throws(() => saveImage(db, id, JPEG_BYTES, "image/jpeg", "overflow.jpg"), /最多 12 张/);
    // 不存在的文件名 / 路径穿越名返回 null。
    assert.equal(readImage(db, id, "missing.png"), null);
    assert.equal(readImage(db, id, "../filmlog.db"), null);
    assert.equal(readImage(db, id, "../../etc/passwd"), null);
    // 删除单张（含落盘）与其余图片。
    const first = getRoll(db, id)!.images[0];
    deleteImage(db, id, first.id);
    assert.equal(readImage(db, id, first.filename), null);
    assert.equal(fs.existsSync(path.join(attachmentDir(id), first.filename)), false);
    deleteImage(db, id, 424242); // 不存在：静默
    assert.equal(getRoll(db, id)?.images.length, MAX_IMAGES_PER_ROLL - 1);
  } finally {
    restore();
  }
});

test("deleteRoll 级联删除图片记录并清理附件目录", () => {
  const restore = withTempDataDir();
  try {
    const db = openFilmDb();
    const id = saveRoll(db, baseInput());
    saveImage(db, id, WEBP_BYTES, "image/webp", "s.webp");
    const filename = getRoll(db, id)!.images[0].filename;
    assert.ok(fs.existsSync(path.join(attachmentDir(id), filename)));
    deleteRoll(db, id);
    assert.equal(getRoll(db, id), null);
    assert.equal(fs.existsSync(attachmentDir(id)), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM film_images WHERE roll_id = ?").get(id) as { n: number }).n, 0);
  } finally {
    restore();
  }
});

test("数据库落盘持久化与附件路径校验", () => {
  const restore = withTempDataDir();
  try {
    assert.throws(() => attachmentDir("../escape" as unknown as number), /编号无效/);
    const db = getFilmDb();
    const id = saveRoll(db, baseInput());
    assert.equal(filmlogDbPath(), path.join(filmlogRootDir(), "filmlog.db"));
    assert.ok(filmlogDbPath().includes(path.join("filmlog", "filmlog.db")));
    // 模拟进程重启：关闭句柄后重新打开，数据仍在。
    resetFilmDbForTest();
    const reopened = getFilmDb();
    assert.equal(reopened.open, true);
    assert.equal(getRoll(reopened, id)?.brand, "Kodak");
  } finally {
    restore();
  }
});

test("图片工具函数：文件名白名单与 mime 反查", () => {
  assert.equal(isValidStoredImageName("abc123.jpg"), true);
  assert.equal(isValidStoredImageName("../a.jpg"), false);
  assert.equal(isValidStoredImageName("a.txt"), false);
  assert.equal(contentTypeOfImage("abc123.jpg"), "image/jpeg");
  assert.equal(contentTypeOfImage("abc123.png"), "image/png");
  assert.equal(contentTypeOfImage("abc123.webp"), "image/webp");
  assert.equal(contentTypeOfImage("abc123.gif"), null);
});

test("validateImage 识别三种真实签名", () => {
  assert.equal(validateImage(JPEG_BYTES, "image/jpeg"), "jpg");
  assert.equal(validateImage(PNG_BYTES, "image/png"), "png");
  assert.equal(validateImage(WEBP_BYTES, "image/webp"), "webp");
  assert.throws(() => validateImage(JPEG_BYTES, "image/png"), /不符/);
  assert.throws(() => validateImage(Buffer.alloc(0), "image/png"), /为空/);
  assert.deepEqual([...FILM_STATUSES], ["stock", "shooting", "shot", "developing", "developed"]);
});
