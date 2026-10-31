// GET /api/documents/files/<file> 回归：DB 先行校验、禁缓存、下载与安全头。
// 隔离方式：每个用例独立的临时 DATA_DIR + 重置全局 SQLite 句柄；不引入 Next 运行时，
// 直接以 Request + params 调用路由处理函数。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GET } from "../src/app/api/documents/files/[file]/route.ts";
import {
  addDocumentFileRow,
  createDocument,
  deleteDocumentFileRow,
  getDocumentsDB,
} from "../src/lib/documents/db.ts";
import { saveDocumentFile, uploadDocumentFiles } from "../src/lib/documents/files.ts";

// Pillow 生成的 1×1 红色图片；保留完整有效编码，而非仅伪造魔数。
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF", "latin1");

type RouteCtx = {
  db: ReturnType<typeof getDocumentsDB>;
  docId: number;
  root: string;
  filesDir: string;
  call: (file: string, search?: string) => Promise<Response>;
};

async function withRouteEnv(run: (ctx: RouteCtx) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-route-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  (globalThis as { __documentsSqlite?: unknown }).__documentsSqlite = undefined;
  const db = getDocumentsDB();
  try {
    const docId = createDocument(db, { title: "路由回归测试", expiryType: "date" });
    const call = (file: string, search = "") =>
      GET(new Request(`http://localhost/api/documents/files/${encodeURIComponent(file)}${search}`), {
        params: Promise.resolve({ file }),
      });
    await run({ db, docId, root, filesDir: path.join(root, "documents", "files"), call });
  } finally {
    db.close();
    (globalThis as { __documentsSqlite?: unknown }).__documentsSqlite = undefined;
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("documents-route-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertPrivateNoStore(res: Response): void {
  const cache = res.headers.get("cache-control") ?? "";
  assert.deepEqual(
    new Set(cache.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)),
    new Set(["private", "no-store"]),
  );
}

function assertSandboxCsp(res: Response): void {
  const csp = res.headers.get("content-security-policy") ?? "";
  const directives = csp.split(";").map((d) => d.trim()).filter(Boolean);
  assert.ok(
    directives.some((d) => /^sandbox(\s|$)/.test(d)),
    `expected a sandbox directive in CSP, got: ${JSON.stringify(csp)}`,
  );
}

test("GET serves stored attachments inline with private/no-store and sandbox CSP", async () => {
  await withRouteEnv(async ({ db, docId, call }) => {
    const [f] = uploadDocumentFiles(db, docId, [{ data: JPEG, mime: "image/jpeg" }]);
    const res = await call(f.file);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assertPrivateNoStore(res);
    assertSandboxCsp(res);
    // 默认内联查看；filename* 回退为存储 token。
    const disposition = res.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^inline(\s*;|$)/);
    const star = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(disposition);
    assert.ok(star, `missing filename* in: ${JSON.stringify(disposition)}`);
    assert.equal(decodeURIComponent(star![1]), f.file);
  });
});

test("PDF attachments keep their content type on inline and download responses", async () => {
  await withRouteEnv(async ({ db, docId, call }) => {
    const [f] = uploadDocumentFiles(db, docId, [{ data: PDF, mime: "application/pdf", name: "合同.pdf" }]);
    for (const search of ["", "?download=1"]) {
      const res = await call(f.file, search);
      assert.equal(res.status, 200, search);
      assert.equal(res.headers.get("content-type"), "application/pdf");
      assertSandboxCsp(res);
      assertPrivateNoStore(res);
    }
  });
});

test("GET is DB-first: disk-only files 404 and deleted rows 404 even with bytes on disk", async () => {
  await withRouteEnv(async ({ db, docId, call }) => {
    // 磁盘上有真实字节、但没有 DB 行 → 必须 404（不得直接读文件系统）。
    const orphan = saveDocumentFile(JPEG, "image/jpeg");
    assert.equal((await call(orphan)).status, 404);

    // 有 DB 行、磁盘缺文件 → 404。
    addDocumentFileRow(db, docId, {
      file: "deadbeefdeadbeefdeadbeef.pdf", name: "", mime: "application/pdf", size: 0, isImage: false,
    });
    assert.equal((await call("deadbeefdeadbeefdeadbeef.pdf")).status, 404);

    // 正常上传可访问；删除行后即便文件仍留在磁盘上也必须 404。
    const [f] = uploadDocumentFiles(db, docId, [{ data: JPEG, mime: "image/jpeg" }]);
    assert.equal((await call(f.file)).status, 200);
    deleteDocumentFileRow(db, f.id);
    assert.equal((await call(f.file)).status, 404);
  });
});

test("invalid attachment filenames are rejected with 404 before disk or DB access", async () => {
  await withRouteEnv(async ({ call }) => {
    for (const bad of ["../escape.pdf", "..%2Fescape.pdf", "a/b.pdf", "A.JPG", "x.gif", ".pdf", "a pdf.jpg", ""]) {
      const res = await call(bad);
      assert.equal(res.status, 404, `filename ${JSON.stringify(bad)}`);
    }
  });
});

test("download=1 switches to attachment with RFC 5987 encoded original filename", async () => {
  await withRouteEnv(async ({ db, docId, call }) => {
    const name = "签证页 扫描件.pdf";
    const [f] = uploadDocumentFiles(db, docId, [{ data: PDF, mime: "application/pdf", name }]);

    const res = await call(f.file, "?download=1");
    assert.equal(res.status, 200);
    const disposition = res.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^attachment/i);
    const star = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(disposition);
    assert.ok(star, `missing RFC 5987 filename* in: ${JSON.stringify(disposition)}`);
    assert.equal(decodeURIComponent(star![1]), name);

    // 默认（无参数）仍是内联查看，且 filename* 编码的是 DB 内的原始文件名。
    const inline = await call(f.file);
    const inlineDisposition = inline.headers.get("content-disposition") ?? "";
    assert.match(inlineDisposition, /^inline(\s*;|$)/);
    assert.doesNotMatch(inlineDisposition, /^attachment/i);
    const inlineStar = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(inlineDisposition);
    assert.ok(inlineStar, `missing filename* in: ${JSON.stringify(inlineDisposition)}`);
    assert.equal(decodeURIComponent(inlineStar![1]), name);
  });
});

test("filename* percent-encodes the RFC 5987 attr-char set (' ( ) *) beyond encodeURIComponent", async () => {
  await withRouteEnv(async ({ db, docId, call }) => {
    // encodeURIComponent 不转义 ' ( ) *；RFC 5987 要求它们必须编码，否则 header 注入/歧义。
    const name = "合同'版(1)*.pdf";
    const [f] = uploadDocumentFiles(db, docId, [{ data: PDF, mime: "application/pdf", name }]);
    const res = await call(f.file, "?download=1");
    assert.equal(res.status, 200);
    const star = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(res.headers.get("content-disposition") ?? "");
    assert.ok(star);
    // 每个特殊字符必须以 %XX 形式出现，且整体可无损解码。
    for (const ch of ["'", "(", ")", "*"]) {
      const hex = ch.charCodeAt(0).toString(16).toUpperCase();
      assert.ok(star![1].includes(`%${hex}`), `expected %${hex} for ${JSON.stringify(ch)} in ${star![1]}`);
    }
    assert.ok(!/['()*]/.test(star![1]), `raw attr-chars must be encoded: ${star![1]}`);
    assert.equal(decodeURIComponent(star![1]), name);
  });
});
