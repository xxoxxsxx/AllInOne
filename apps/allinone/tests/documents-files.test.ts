import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDocument, openDocumentsDB, MAX_FILES_PER_DOCUMENT } from "../src/lib/documents/db.ts";
import {
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  contentTypeOf,
  documentsFileDir,
  isValidDocumentFilename,
  readDocumentFile,
  removeDocumentFile,
  removeDocumentFiles,
  sanitizeOriginalName,
  saveDocumentFile,
  uploadDocumentFiles,
} from "../src/lib/documents/files.ts";

// Pillow 生成的 1×1 红色图片；保留完整有效编码，而非仅伪造魔数。
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
  "base64",
);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF", "latin1");
const jpeg = () => ({ data: JPEG, mime: "image/jpeg" });

function withStorage(run: (ctx: {
  db: ReturnType<typeof openDocumentsDB>;
  docId: number;
  diskFiles: () => string[];
  rowCount: () => number;
}) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-files-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  const db = openDocumentsDB(undefined, path.join(root, "documents.db"));
  try {
    const docId = createDocument(db, { title: "附件回归测试", expiryType: "date" });
    run({
      db,
      docId,
      diskFiles: () => (fs.existsSync(documentsFileDir()) ? fs.readdirSync(documentsFileDir()).sort() : []),
      rowCount: () => (db.prepare("SELECT COUNT(*) AS n FROM document_files").get() as { n: number }).n,
    });
  } finally {
    db.close();
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("documents-files-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("upload persists images and PDF with matching rows, bytes and flags", () => {
  withStorage(({ db, docId, diskFiles, rowCount }) => {
    const inputs = [jpeg(), { data: PNG, mime: "image/png" }, { data: PDF, mime: "application/pdf", name: "签证页.pdf" }];
    const files = uploadDocumentFiles(db, docId, inputs);
    assert.equal(files.length, 3);
    assert.equal(rowCount(), 3);
    assert.deepEqual(diskFiles(), files.map((f) => f.file).sort());
    assert.deepEqual(files.map((f) => f.isImage), [true, true, false]);
    assert.equal(files[2].name, "签证页.pdf");
    assert.deepEqual(files.map((f) => path.extname(f.file)), [".jpg", ".png", ".pdf"]);
    files.forEach((f, i) => {
      assert.ok(f.id > 0);
      assert.deepEqual(readDocumentFile(f.file), inputs[i].data);
      assert.equal(f.size, inputs[i].data.length);
    });
  });
});

test("validates every file before writing anything; wrong mime or fake headers rejected", () => {
  withStorage(({ db, docId, diskFiles, rowCount }) => {
    const bad = [
      { data: Buffer.from("fake-jpeg-bytes"), mime: "image/jpeg" },
      { data: PNG, mime: "image/jpeg" },
      { data: JPEG, mime: "image/png" },
      { data: Buffer.from("not a pdf"), mime: "application/pdf" },
      { data: JPEG, mime: "image/gif" },
      { data: JPEG, mime: "toString" },
      { data: Buffer.alloc(0), mime: "image/jpeg" },
      { data: PNG.subarray(0, 7), mime: "image/png" },
      { data: PDF.subarray(0, 4), mime: "application/pdf" },
    ];
    for (const input of bad) {
      assert.throws(() => uploadDocumentFiles(db, docId, [jpeg(), input]));
      assert.equal(rowCount(), 0);
      assert.deepEqual(diskFiles(), []);
      assert.equal(fs.existsSync(documentsFileDir()), false);
    }
  });
});

test("missing document and invalid batch counts create no files or rows", () => {
  withStorage(({ db, docId, diskFiles, rowCount }) => {
    assert.throws(() => uploadDocumentFiles(db, docId + 100, [jpeg()]), /证件不存在/);
    assert.throws(() => uploadDocumentFiles(db, docId, []), /请选择附件/);
    assert.throws(
      () => uploadDocumentFiles(db, docId, Array.from({ length: MAX_FILES_PER_DOCUMENT + 1 }, jpeg)),
      new RegExp(`每批最多.*${MAX_FILES_PER_DOCUMENT}`),
    );
    assert.equal(rowCount(), 0);
    assert.deepEqual(diskFiles(), []);
    assert.equal(fs.existsSync(documentsFileDir()), false);
  });
});

test("document accepts exactly the cap and rejects batches exceeding remaining capacity", () => {
  withStorage(({ db, docId, diskFiles, rowCount }) => {
    uploadDocumentFiles(db, docId, Array.from({ length: MAX_FILES_PER_DOCUMENT - 1 }, jpeg));
    const before = diskFiles();
    assert.throws(() => uploadDocumentFiles(db, docId, [jpeg(), jpeg()]), /最多.*12/);
    assert.equal(rowCount(), MAX_FILES_PER_DOCUMENT - 1);
    assert.deepEqual(diskFiles(), before);
    uploadDocumentFiles(db, docId, [jpeg()]);
    assert.equal(rowCount(), MAX_FILES_PER_DOCUMENT);
    assert.throws(() => uploadDocumentFiles(db, docId, [jpeg()]), /每份证件最多.*12/);
    assert.equal(rowCount(), MAX_FILES_PER_DOCUMENT);
  });
});

test("size limits: 10MB per file, 30MB per batch, boundaries exact", () => {
  withStorage(({ db, docId, rowCount }) => {
    const sized = (bytes: number) => ({ data: Buffer.concat([JPEG, Buffer.alloc(bytes - JPEG.length)]), mime: "image/jpeg" });
    assert.throws(() => uploadDocumentFiles(db, docId, [sized(MAX_FILE_BYTES + 1)]), /10MB/);
    assert.throws(
      () => uploadDocumentFiles(db, docId, Array.from({ length: 4 }, () => sized(8 * 1024 * 1024))),
      /30MB/,
    );
    assert.equal(rowCount(), 0);
    uploadDocumentFiles(db, docId, [sized(MAX_FILE_BYTES), ...Array.from({ length: 4 }, () => sized(5 * 1024 * 1024))]);
    assert.equal(rowCount(), 5);
  });
});

test("second insert failure rolls back the whole batch and keeps only prior files", () => {
  withStorage(({ db, docId, diskFiles, rowCount }) => {
    const existing = uploadDocumentFiles(db, docId, [jpeg()]);
    const before = diskFiles();
    db.exec(`CREATE TRIGGER fail_second_doc_file BEFORE INSERT ON document_files
      WHEN (SELECT COUNT(*) FROM document_files) >= 2
      BEGIN SELECT RAISE(ABORT, 'injected file insert failure'); END;`);
    assert.throws(() => uploadDocumentFiles(db, docId, [jpeg(), jpeg()]), /injected file insert failure/);
    assert.equal(rowCount(), 1);
    assert.deepEqual(diskFiles(), before);
    assert.deepEqual(readDocumentFile(existing[0].file), JPEG);
  });
});

test("sanitizeOriginalName strips paths and control characters", () => {
  assert.equal(sanitizeOriginalName("../../etc/passwd.jpg"), "....etcpasswd.jpg");
  assert.equal(sanitizeOriginalName("  护照 扫描件 .PDF \n"), "护照 扫描件 .PDF");
  assert.equal(sanitizeOriginalName("a\u0000b"), "ab");
  assert.equal(sanitizeOriginalName("x".repeat(200)), "x".repeat(120));
  assert.equal(sanitizeOriginalName(undefined), "");
});

test("removeDocumentFile restricts names, ignores ENOENT and propagates other errors", () => {
  withStorage(() => {
    const file = saveDocumentFile(PDF, "application/pdf");
    assert.ok(path.isAbsolute(documentsFileDir()));
    for (const invalid of ["../outside.pdf", path.join(documentsFileDir(), file), "a/b.pdf", "a.gif", "a.pdf\n", ""]) {
      assert.throws(() => removeDocumentFile(invalid), /文件名/);
    }
    assert.deepEqual(readDocumentFile(file), PDF);
    removeDocumentFile(file);
    assert.equal(readDocumentFile(file), null);
    assert.doesNotThrow(() => removeDocumentFile(file));
    fs.mkdirSync(path.join(documentsFileDir(), "directory.pdf"));
    assert.throws(
      () => removeDocumentFiles(["directory.pdf", file, "missing.pdf"]),
      AggregateError,
    );
    assert.equal(readDocumentFile(file), null);
  });
});

test("MAX_BATCH_BYTES is 30MB and MAX_FILE_BYTES is 10MB", () => {
  assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_BATCH_BYTES, 30 * 1024 * 1024);
});

// —— 回归补充：与 /api/documents/files 路由及多批上传相关的存储契约 ——

test("contentTypeOf matches the whitelisted extensions served by the route", () => {
  assert.equal(contentTypeOf("abc123.jpg"), "image/jpeg");
  assert.equal(contentTypeOf("abc123.png"), "image/png");
  assert.equal(contentTypeOf("abc123.webp"), "image/webp");
  assert.equal(contentTypeOf("abc123.pdf"), "application/pdf");
});

test("saved filenames are whitelisted, lowercase and unique across saves", () => {
  withStorage(() => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const file = saveDocumentFile(JPEG, "image/jpeg");
      assert.ok(isValidDocumentFilename(file), file);
      assert.ok(!seen.has(file), "文件名必须唯一");
      seen.add(file);
    }
  });
});

test("sort_order follows insertion order across separate upload batches", () => {
  withStorage(({ db, docId }) => {
    const first = uploadDocumentFiles(db, docId, [jpeg(), { data: PNG, mime: "image/png" }]);
    const second = uploadDocumentFiles(db, docId, [{ data: PDF, mime: "application/pdf", name: "合同.pdf" }]);
    const rows = db
      .prepare(`SELECT file FROM document_files WHERE document_id=? ORDER BY sort_order,id`)
      .all(docId) as Array<{ file: string }>;
    assert.deepEqual(rows.map((r) => r.file), [
      first[0].file,
      first[1].file,
      second[0].file,
    ]);
  });
});
