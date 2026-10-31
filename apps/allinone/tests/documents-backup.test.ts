// backup.ts + GET /api/documents/backup 回归：
// - buildDocumentBackup：manifest 完整性（全部字段含 sort_order/duration/tags/files）与
//   附件字节原样打包的往返校验；缺失/空字节附件进 stats.missing 与 manifest.missing_files；
//   存储名冲突抛错；空库产出仅含清单的合法 ZIP；体量护栏与确定性。
// - 路由：200 ZIP 头（application/zip、filename*=UTF-8''documents-backup-YYYYMMDD-HHmmss.zip、
//   no-store）、文件名时间戳与 manifest 一致、缺失附件 500 JSON、其他错误 500 JSON。
// 隔离方式与 documents-route.test.ts 相同：独立临时 DATA_DIR + 重置 globalThis.__documentsSqlite。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GET } from "../src/app/api/documents/backup/route.ts";
import {
  addDocumentFileRow,
  createCategory,
  createDocument,
  createHolder,
  getDocumentsDB,
  reorderDocuments,
} from "../src/lib/documents/db.ts";
import { readDocumentFile, uploadDocumentFiles } from "../src/lib/documents/files.ts";
import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  backupFileName,
  buildDocumentBackup,
  type BackupManifest,
} from "../src/lib/documents/backup.ts";
import { parseZip } from "./documents-zip-parser.ts";

// Pillow 生成的 1×1 红色 JPEG（与 documents-route.test.ts 同源），保留完整有效编码。
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF", "latin1");
const FIXED_NOW = new Date("2026-11-01T00:31:50+08:00");

type BackupEnv = {
  db: ReturnType<typeof getDocumentsDB>;
  root: string;
};

async function withBackupEnv(run: (env: BackupEnv) => Promise<void> | void): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-backup-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  (globalThis as { __documentsSqlite?: unknown }).__documentsSqlite = undefined;
  const db = getDocumentsDB();
  try {
    await run({ db, root });
  } finally {
    db.close();
    (globalThis as { __documentsSqlite?: unknown }).__documentsSqlite = undefined;
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("documents-backup-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function manifestEntryOf(zip: Buffer): BackupManifest {
  const parsed = parseZip(zip);
  const entry = parsed.entries.find((e) => e.name === "backup/manifest.json");
  assert.ok(entry, "ZIP 内必须存在 backup/manifest.json");
  return JSON.parse(entry.data.toString("utf8")) as BackupManifest;
}

function shanghaiStampOf(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const p = (type: string) => parts.find((x) => x.type === type)!.value;
  return `${p("year")}${p("month")}${p("day")}-${p("hour")}${p("minute")}${p("second")}`;
}

test("backupFileName stamps documents-backup-YYYYMMDD-HHmmss.zip in Asia/Shanghai", () => {
  assert.equal(backupFileName(new Date("2026-11-01T00:31:50+08:00")), "documents-backup-20261101-003150.zip");
  // 午夜用 h23 小时制，不得出现 "24"。
  assert.equal(backupFileName(new Date("2026-11-01T00:00:00+08:00")), "documents-backup-20261101-000000.zip");
  // UTC 01-01 16:24 → 上海 01-02 凌晨（跨日换算正确）。
  assert.equal(backupFileName(new Date("2026-11-01T16:24:09Z")), "documents-backup-20261102-002409.zip");
});

test("buildDocumentBackup round-trips the full manifest and original attachment bytes", async () => {
  await withBackupEnv(({ db }) => {
    const holderId = createHolder(db, "张三");
    const categoryId = createCategory(db, "家庭证件");
    const docA = createDocument(db, {
      title: "护照",
      number: "E12345678",
      issuer: "公安部出入境管理局",
      holderId,
      categoryId,
      startDate: "2020-01-15",
      expiryType: "date",
      expiryDate: "2030-01-15",
      note: "首页 + 签注页",
      tags: ["出行", "重要"],
    });
    const filesA = uploadDocumentFiles(db, docA, [
      { data: JPEG, mime: "image/jpeg", name: "护照首页.jpg" },
      { data: PDF, mime: "application/pdf", name: "签证页 扫描件.pdf" },
    ]);
    const docB = createDocument(db, {
      title: "签证",
      expiryType: "duration",
      startDate: "2024-06-01",
      durationValue: 12,
      durationUnit: "month",
      tags: ["出行"],
    });
    const docC = createDocument(db, { title: "最小证件", expiryType: "date" });
    // 自由排序：把 B 排到最前，验证 manifest 记录的是 DB sort_order 而非列表顺序。
    reorderDocuments(db, [docB, docA, docC]);

    const result = buildDocumentBackup(db, readDocumentFile, { generatedAt: FIXED_NOW });
    assert.deepEqual(result.stats, { documents: 3, files: 2, missing: [] });

    const parsed = parseZip(result.zip);
    assert.deepEqual(
      parsed.entries.map((e) => e.name),
      ["backup/manifest.json", `files/${filesA[0]!.file}`, `files/${filesA[1]!.file}`],
    );
    // 附件字节与磁盘上完全一致；CRC/尺寸/偏移自洽由 parseZip 校验。
    assert.deepEqual(parsed.entries[1]!.data, JPEG);
    assert.deepEqual(parsed.entries[2]!.data, PDF);

    const manifest = manifestEntryOf(result.zip);
    assert.equal(manifest.schema_version, BACKUP_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.generated_at, FIXED_NOW.toISOString());
    assert.deepEqual(manifest.counts, {
      documents: 3,
      files: 2,
      holders: 1,
      categories: 9, // 8 个默认分类 + 「家庭证件」
      tags: 2,
      missing_files: 0,
    });
    assert.deepEqual(manifest.missing_files, []);
    assert.deepEqual(manifest.holders, [{ id: holderId, name: "张三", created_at: manifest.holders[0]!.created_at }]);
    assert.ok(manifest.holders[0]!.created_at.length > 0);
    assert.ok(manifest.categories.some((c) => c.id === categoryId && c.name === "家庭证件" && typeof c.sort_order === "number"));
    assert.ok(manifest.categories.every((c) => typeof c.created_at === "string" && c.created_at.length > 0));
    assert.deepEqual(manifest.tags.map((t) => t.name), ["出行", "重要"]);
    assert.ok(manifest.tags.every((t) => typeof t.id === "number" && t.created_at.length > 0));

    const [mB, mA, mC] = manifest.documents; // 与 reorder 后的列表顺序一致
    assert.equal(mB!.sort_order, 0);
    assert.equal(mA!.sort_order, 1);
    assert.equal(mC!.sort_order, 2);

    assert.equal(mA!.id, docA);
    assert.equal(mA!.title, "护照");
    assert.equal(mA!.number, "E12345678");
    assert.equal(mA!.issuer, "公安部出入境管理局");
    assert.equal(mA!.holder_id, holderId);
    assert.equal(mA!.holder_name, "张三");
    assert.equal(mA!.category_id, categoryId);
    assert.equal(mA!.category_name, "家庭证件");
    assert.equal(mA!.start_date, "2020-01-15");
    assert.equal(mA!.expiry_date, "2030-01-15");
    assert.equal(mA!.duration_value, null);
    assert.equal(mA!.duration_unit, null);
    assert.equal(mA!.note, "首页 + 签注页");
    assert.deepEqual(
      mA!.tags,
      manifest.tags.filter((t) => t.name === "出行" || t.name === "重要").map((t) => ({ id: t.id, name: t.name })),
    );
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(mA!.created_at));
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(mA!.updated_at));
    assert.equal(mA!.status, "valid");
    assert.equal(typeof mA!.days_left, "number");
    assert.deepEqual(
      mA!.files.map((f) => [f.file, f.name, f.mime, f.size, f.is_image]),
      [
        [filesA[0]!.file, "护照首页.jpg", "image/jpeg", JPEG.length, true],
        [filesA[1]!.file, "签证页 扫描件.pdf", "application/pdf", PDF.length, false],
      ],
    );

    assert.equal(mB!.title, "签证");
    assert.equal(mB!.holder_id, null);
    assert.equal(mB!.holder_name, null);
    assert.equal(mB!.category_id, null);
    assert.equal(mB!.start_date, "2024-06-01");
    assert.equal(mB!.expiry_date, "2025-06-01"); // duration 12 个月折算
    assert.equal(mB!.duration_value, 12);
    assert.equal(mB!.duration_unit, "month");
    assert.deepEqual(mB!.tags.map((t) => t.name), ["出行"]);
    assert.deepEqual(mB!.files, []);

    assert.equal(mC!.title, "最小证件");
    assert.deepEqual(mC!.files, []);
    assert.deepEqual(mC!.tags, []);
  });
});

test("missing attachment is recorded in stats.missing and manifest.missing_files without throwing", async () => {
  await withBackupEnv(({ db }) => {
    const docId = createDocument(db, { title: "缺失附件", expiryType: "date" });
    const ghost = "deadbeefdeadbeefdeadbeef.pdf";
    addDocumentFileRow(db, docId, { file: ghost, name: "丢失.pdf", mime: "application/pdf", size: 123, isImage: false });
    const [real] = uploadDocumentFiles(db, docId, [{ data: JPEG, mime: "image/jpeg" }]);

    const result = buildDocumentBackup(db, readDocumentFile, { generatedAt: FIXED_NOW });
    assert.deepEqual(result.stats.missing, [ghost]);
    assert.equal(result.stats.files, 2);

    const manifest = manifestEntryOf(result.zip);
    assert.deepEqual(manifest.missing_files, [ghost]);
    assert.equal(manifest.counts.missing_files, 1);
    assert.equal(manifest.counts.files, 2);
    const doc = manifest.documents.find((d) => d.id === docId)!;
    assert.deepEqual(
      doc.files.map((f) => [f.file, f.size]),
      [[ghost, 123], [real!.file, real!.size]],
    );
    // 缺失附件没有对应的 ZIP 条目，其余附件照常打包。
    const names = parseZip(result.zip).entries.map((e) => e.name);
    assert.ok(!names.includes(`files/${ghost}`));
    assert.ok(names.includes(`files/${real!.file}`));
  });
});

test("empty attachment bytes are treated as missing (never silently packed)", async () => {
  await withBackupEnv(({ db }) => {
    const docId = createDocument(db, { title: "空附件", expiryType: "date" });
    const token = "cafebabecafebabecafebabe.pdf";
    addDocumentFileRow(db, docId, { file: token, name: "", mime: "application/pdf", size: 0, isImage: false });
    const result = buildDocumentBackup(
      db,
      (file) => (file === token ? Buffer.alloc(0) : null),
      { generatedAt: FIXED_NOW },
    );
    assert.deepEqual(result.stats.missing, [token]);
    assert.deepEqual(manifestEntryOf(result.zip).missing_files, [token]);
  });
});

test("non-Buffer readAttachment results are rejected loudly", async () => {
  await withBackupEnv(({ db }) => {
    const docId = createDocument(db, { title: "类型异常", expiryType: "date" });
    addDocumentFileRow(db, docId, { file: "aaaabbbbaaaabbbb.pdf", name: "", mime: "application/pdf", size: 1, isImage: false });
    assert.throws(
      () => buildDocumentBackup(db, () => "not-a-buffer" as unknown as Buffer, { generatedAt: FIXED_NOW }),
      /Buffer/,
    );
  });
});

test("duplicate stored filenames collide loudly instead of losing data", async () => {
  await withBackupEnv(({ db }) => {
    const docId = createDocument(db, { title: "重名附件", expiryType: "date" });
    const [f] = uploadDocumentFiles(db, docId, [{ data: JPEG, mime: "image/jpeg" }]);
    addDocumentFileRow(db, docId, {
      file: f!.file, name: "同名.jpg", mime: "image/jpeg", size: JPEG.length, isImage: true,
    });
    assert.throws(() => buildDocumentBackup(db, readDocumentFile, { generatedAt: FIXED_NOW }), /冲突/);
  });
});

test("empty database still yields a valid manifest-only ZIP", async () => {
  await withBackupEnv(({ db }) => {
    const result = buildDocumentBackup(db, readDocumentFile, { generatedAt: FIXED_NOW });
    const parsed = parseZip(result.zip);
    assert.deepEqual(result.stats, { documents: 0, files: 0, missing: [] });
    assert.deepEqual(
      parsed.entries.map((e) => e.name),
      ["backup/manifest.json"],
    );
    const manifest = manifestEntryOf(result.zip);
    assert.deepEqual(manifest.documents, []);
    assert.deepEqual(manifest.counts, {
      documents: 0,
      files: 0,
      holders: 0,
      categories: 8, // 默认分类
      tags: 0,
      missing_files: 0,
    });
    assert.deepEqual(manifest.missing_files, []);
  });
});

test("backup size guard throws before building when over the limit", async () => {
  await withBackupEnv(({ db }) => {
    const docId = createDocument(db, { title: "体量护栏", expiryType: "date" });
    uploadDocumentFiles(db, docId, [{ data: JPEG, mime: "image/jpeg" }]);
    // 真实附件远小于 2GB；用收紧的 maxBytes 验证「打包前」护栏路径。
    assert.throws(
      () => buildDocumentBackup(db, readDocumentFile, { generatedAt: FIXED_NOW, maxBytes: 16 }),
      /上限/,
    );
    // 默认上限（2GB）下正常构建。
    const result = buildDocumentBackup(db, readDocumentFile, { generatedAt: FIXED_NOW });
    assert.deepEqual(result.stats.missing, []);
  });
});

test("buildDocumentBackup is deterministic for a fixed generatedAt", async () => {
  await withBackupEnv(({ db }) => {
    const docId = createDocument(db, { title: "确定性", expiryType: "date" });
    uploadDocumentFiles(db, docId, [{ data: JPEG, mime: "image/jpeg", name: "首页.jpg" }]);
    const a = buildDocumentBackup(db, readDocumentFile, { generatedAt: FIXED_NOW });
    const b = buildDocumentBackup(db, readDocumentFile, { generatedAt: FIXED_NOW });
    assert.deepEqual(a.zip, b.zip);
    assert.equal(a.manifest.generated_at, FIXED_NOW.toISOString());
  });
});

test("GET /api/documents/backup returns a complete ZIP with required headers", async () => {
  await withBackupEnv(async ({ db }) => {
    const docId = createDocument(db, {
      title: "路由备份",
      expiryType: "duration",
      startDate: "2025-11-01",
      durationValue: 5,
      durationUnit: "year",
      tags: ["回归"],
    });
    const files = uploadDocumentFiles(db, docId, [{ data: PDF, mime: "application/pdf", name: "合同 文件.pdf" }]);

    const res = await GET();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const disposition = res.headers.get("content-disposition") ?? "";
    const m = /^attachment; filename\*=UTF-8''(documents-backup-\d{8}-\d{6}\.zip)$/.exec(disposition);
    assert.ok(m, `Content-Disposition 不符合预期：${JSON.stringify(disposition)}`);

    const zip = Buffer.from(await res.arrayBuffer());
    const parsed = parseZip(zip);
    assert.deepEqual(
      parsed.entries.map((e) => e.name),
      ["backup/manifest.json", `files/${files[0]!.file}`],
    );
    assert.deepEqual(parsed.entries[1]!.data, PDF);
    const manifest = JSON.parse(parsed.entries[0]!.data.toString("utf8")) as BackupManifest;
    assert.equal(manifest.schema_version, BACKUP_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.documents.length, 1);
    assert.equal(manifest.documents[0]!.duration_value, 5);
    assert.equal(manifest.documents[0]!.duration_unit, "year");
    assert.equal(manifest.documents[0]!.expiry_date, "2030-11-01");
    assert.deepEqual(manifest.missing_files, []);
    // 文件名时间戳（Asia/Shanghai）与 manifest 的 generated_at 一致。
    assert.equal(m[1], `documents-backup-${shanghaiStampOf(manifest.generated_at)}.zip`);
  });
});

test("GET fails with 500 JSON listing missing attachments instead of an incomplete backup", async () => {
  await withBackupEnv(async ({ db }) => {
    const docId = createDocument(db, { title: "路由缺失", expiryType: "date" });
    addDocumentFileRow(db, docId, {
      file: "deadbeefdeadbeefdeadbeef.pdf", name: "丢失.pdf", mime: "application/pdf", size: 9, isImage: false,
    });
    const res = await GET();
    assert.equal(res.status, 500);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const body = (await res.json()) as { error: string; missing: string[] };
    assert.match(body.error, /缺失/);
    assert.ok(body.error.includes("deadbeefdeadbeefdeadbeef.pdf"));
    assert.deepEqual(body.missing, ["deadbeefdeadbeefdeadbeef.pdf"]);
  });
});

test("GET wraps unexpected build errors as 500 JSON", async () => {
  await withBackupEnv(async ({ db }) => {
    assert.ok(db); // 环境就绪
    // 注入伪句柄：transaction(...).immediate() 直接执行回调（模拟 better-sqlite3 语义），
    // prepare 即抛错，模拟快照收集期的数据库错误（不触碰真实数据目录）。
    (globalThis as { __documentsSqlite?: unknown }).__documentsSqlite = {
      transaction: (fn: () => unknown) => ({ immediate: fn }),
      prepare: () => {
        throw new Error("模拟构建失败");
      },
    };
    const res = await GET();
    assert.equal(res.status, 500);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /^备份失败：/);
    assert.ok(body.error.includes("模拟构建失败"));
  });
});
