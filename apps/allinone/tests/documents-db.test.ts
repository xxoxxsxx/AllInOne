import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CATEGORIES,
  EXPIRY_WARN_DAYS,
  addDuration,
  createCategory,
  createDocument,
  createHolder,
  deleteCategory,
  deleteDocument,
  deleteHolder,
  documentsSummary,
  getDocument,
  listCategories,
  listDocuments,
  listHolders,
  listTags,
  openDocumentsDB,
  reorderDocuments,
  renameCategory,
  renameHolder,
  statusOf,
  todayStr,
  updateDocument,
} from "../src/lib/documents/db.ts";

function withDb(run: (db: ReturnType<typeof openDocumentsDB>) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-db-"));
  const db = openDocumentsDB(root);
  try {
    run(db);
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("documents-db-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("migrate seeds default categories and starts at current schema version", () => {
  withDb((db) => {
    assert.deepEqual(listCategories(db).map((c) => c.name), [...DEFAULT_CATEGORIES]);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    assert.deepEqual(listHolders(db), []);
    assert.deepEqual(listTags(db), []);
  });
});

test("todayStr / addDuration use calendar arithmetic with month-end clamping", () => {
  assert.equal(addDuration("2024-01-31", 1, "month"), "2024-02-29");
  assert.equal(addDuration("2023-01-31", 1, "month"), "2023-02-28");
  assert.equal(addDuration("2024-01-31", 12, "month"), "2025-01-31");
  assert.equal(addDuration("2024-02-29", 1, "year"), "2025-02-28");
  assert.equal(addDuration("2024-03-10", 90, "day"), "2024-06-08");
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/);
});

test("statusOf marks expired / expiring (30d) / valid boundaries", () => {
  const today = "2026-10-31";
  assert.deepEqual(statusOf("2026-10-30", today), { status: "expired", daysLeft: -1 });
  assert.deepEqual(statusOf("2026-10-31", today), { status: "expiring", daysLeft: 0 });
  assert.deepEqual(statusOf(addDuration(today, EXPIRY_WARN_DAYS, "day"), today), {
    status: "expiring",
    daysLeft: EXPIRY_WARN_DAYS,
  });
  assert.deepEqual(statusOf(addDuration(today, EXPIRY_WARN_DAYS + 1, "day"), today).status, "valid");
  assert.deepEqual(statusOf("", today), { status: "valid", daysLeft: null });
});

test("createDocument stores fields, computes duration expiry and links tags", () => {
  withDb((db) => {
    const holderId = createHolder(db, "爸爸");
    const categoryId = listCategories(db).find((c) => c.name === "护照")!.id;
    const id = createDocument(db, {
      holderId,
      categoryId,
      title: "因私护照",
      number: "E12345678",
      issuer: "出入境管理局",
      startDate: "2026-01-10",
      expiryType: "duration",
      durationValue: 5,
      durationUnit: "year",
      note: "抽屉里",
      tags: ["出行", "常用", "出行"],
    });
    const doc = getDocument(db, id)!;
    assert.ok(doc);
    assert.equal(doc.expiryDate, "2031-01-10");
    assert.equal(doc.durationValue, 5);
    assert.equal(doc.durationUnit, "year");
    assert.equal(doc.holderName, "爸爸");
    assert.equal(doc.categoryName, "护照");
    assert.deepEqual(doc.tags.map((t) => t.name).sort(), ["出行", "常用"]);
    assert.deepEqual(listTags(db).map((t) => t.name).sort(), ["出行", "常用"]);
    assert.ok(doc.daysLeft !== null && doc.daysLeft > 0);
  });
});

test("createDocument validates title, dates, refs and duration bounds without writing", () => {
  withDb((db) => {
    const categoryId = listCategories(db)[0].id;
    const bad: Array<[Parameters<typeof createDocument>[1], RegExp]> = [
      [{ title: "", expiryType: "date", expiryDate: "2030-01-01" }, /证件名称/],
      [{ title: "X", expiryType: "date", expiryDate: "2030/01/01" }, /失效时间/],
      [{ title: "X", expiryType: "date", expiryDate: "2030-13-01" }, /失效时间/],
      [{ title: "X", expiryType: "duration", startDate: "2026-01-01", durationValue: 0, durationUnit: "year" }, /时长/],
      [{ title: "X", expiryType: "duration", startDate: "2026-01-01", durationValue: 101, durationUnit: "year" }, /时长过大/],
      [{ title: "X", expiryType: "duration", startDate: "", durationValue: 5, durationUnit: "year" }, /开始日期/],
      [{ title: "X", expiryType: "date", holderId: 999 }, /持有人不存在/],
      [{ title: "X", expiryType: "date", categoryId: 999 }, /分类不存在/],
      [{ title: "X".repeat(101), expiryType: "date" }, /最多 100 个字符/],
    ];
    for (const [input, re] of bad) {
      assert.throws(() => createDocument(db, input as Parameters<typeof createDocument>[1]), re);
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }).n, 0);
  });
});

test("updateDocument replaces editable fields and tags; missing id rejected", () => {
  withDb((db) => {
    const categoryId = listCategories(db)[0].id;
    const otherCategory = createCategory(db, "会员卡");
    const id = createDocument(db, { title: "旧标题", categoryId, expiryType: "date", expiryDate: "2027-01-01", tags: ["a"] });
    updateDocument(db, id, {
      title: "新标题",
      categoryId: otherCategory,
      expiryType: "duration",
      startDate: "2026-02-01",
      durationValue: 6,
      durationUnit: "month",
      tags: ["b", "c"],
    });
    const doc = getDocument(db, id)!;
    assert.equal(doc.title, "新标题");
    assert.equal(doc.categoryName, "会员卡");
    assert.equal(doc.expiryDate, "2026-08-01");
    assert.deepEqual(doc.tags.map((t) => t.name).sort(), ["b", "c"]);
    assert.throws(() => updateDocument(db, id + 100, { title: "X", expiryType: "date" }), /证件不存在/);
  });
});

test("listDocuments keeps custom order, appends new docs at the end, and summary counts statuses", () => {
  withDb((db) => {
    const today = todayStr();
    const mk = (expiry: string) => createDocument(db, { title: `证件 ${expiry || "长期"}`, expiryType: "date", expiryDate: expiry });
    const far = mk("2030-01-01");
    const soon = mk(addDuration(today, EXPIRY_WARN_DAYS, "day"));
    const past = mk(addDuration(today, -3, "day"));
    const forever = mk("");
    const docs = listDocuments(db, today);
    assert.deepEqual(docs.map((d) => d.id), [far, soon, past, forever]);
    const summary = documentsSummary(db, today);
    assert.deepEqual(summary, { total: 4, expiring: 1, expired: 1 });
  });
});

test("reorderDocuments persists an explicit permutation and rejects mismatched ids", () => {
  withDb((db) => {
    const a = createDocument(db, { title: "A", expiryType: "date" });
    const b = createDocument(db, { title: "B", expiryType: "date" });
    const c = createDocument(db, { title: "C", expiryType: "date" });
    reorderDocuments(db, [c, a, b]);
    assert.deepEqual(listDocuments(db).map((d) => d.id), [c, a, b]);
    // 新证件排到末尾。
    const d = createDocument(db, { title: "D", expiryType: "date" });
    assert.deepEqual(listDocuments(db).map((x) => x.id), [c, a, b, d]);
    for (const bad of [[a, b], [a, b, c, d, a], [a, b, c, 999]]) {
      assert.throws(() => reorderDocuments(db, bad as number[]), /排序数据与证件列表不一致/);
    }
    assert.deepEqual(listDocuments(db).map((x) => x.id), [c, a, b, d]);
  });
});

test("deleteDocument cascades tags/files rows and returns stored files for disk cleanup", () => {
  withDb((db) => {
    const id = createDocument(db, { title: "待删除", expiryType: "date", tags: ["x"] });
    db.prepare(
      `INSERT INTO document_files(document_id,file,name,mime,size,is_image,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(id, "a.jpg", "a.jpg", "image/jpeg", 1, 1, 0, "now");
    const files = deleteDocument(db, id);
    assert.deepEqual(files, ["a.jpg"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM document_tags").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM document_files").get() as { n: number }).n, 0);
    // 标签是全局共享的：删除证件不回收标签本身。
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }).n, 1);
  });
});

test("holders/categories rename and delete keep documents with NULL refs", () => {
  withDb((db) => {
    const holderId = createHolder(db, "妈妈");
    const holderId2 = createHolder(db, "爸爸");
    const categoryId = listCategories(db).find((c) => c.name === "护照")!.id;
    const id = createDocument(db, { holderId, categoryId, title: "证件", expiryType: "date" });
    renameHolder(db, holderId, "母亲");
    assert.equal(getDocument(db, id)!.holderName, "母亲");
    deleteHolder(db, holderId);
    deleteCategory(db, categoryId);
    const doc = getDocument(db, id)!;
    assert.equal(doc.holderId, null);
    assert.equal(doc.holderName, null);
    assert.equal(doc.categoryId, null);
    assert.throws(() => createHolder(db, "爸爸"), /持有人已存在/);
    assert.throws(() => createCategory(db, "其他"), /分类已存在/);
    assert.throws(() => renameHolder(db, holderId, "再改"), /持有人不存在/);
    assert.deepEqual(listHolders(db).map((h) => h.id), [holderId2]);
  });
});

// —— 日期与状态回归（北京时间统一 + 真实日期边界） ——

test("todayStr is computed in Asia/Shanghai regardless of host timezone", () => {
  // 2026-10-31 15:59:59Z = 北京时间 23:59:59 → 当天；16:00:00Z = 次日 00:00:00。
  assert.equal(todayStr(Date.UTC(2026, 9, 31, 15, 59, 59)), "2026-10-31");
  assert.equal(todayStr(Date.UTC(2026, 9, 31, 16, 0, 0)), "2026-11-01");
  // UTC 日期早于北京日期的清晨时段同样正确。
  assert.equal(todayStr(Date.UTC(2026, 0, 1, 0, 30, 0)), "2026-01-01");
});

test("statusOf reports upcoming for future start unless expiring/expired takes precedence", () => {
  const today = "2026-10-31";
  // 无到期日 + 开始日在未来 → 尚未生效。
  assert.deepEqual(statusOf("", today, "2026-11-05"), { status: "upcoming", daysLeft: null });
  // 有到期日且未进提醒窗口 + 开始日在未来 → 尚未生效。
  assert.deepEqual(statusOf("2027-01-01", today, "2026-11-05"), { status: "upcoming", daysLeft: 62 });
  // 开始日 == 今天：已生效（仅严格晚于今天才算未生效）。
  assert.equal(statusOf("", today, today).status, "valid");
  // 未来开始但到期日已进入 30 天提醒窗口 → expiring 优先。
  assert.deepEqual(statusOf("2026-11-10", today, "2026-11-01"), { status: "expiring", daysLeft: 10 });
  // 到期日已过 → expired 优先，即使开始日在未来。
  assert.equal(statusOf("2026-10-30", today, "2026-11-01").status, "expired");
});

test("dates must be real calendar dates: year 0000 and impossible days rejected", () => {
  withDb((db) => {
    for (const expiryDate of ["0000-01-01", "0000-12-31", "2026-02-30", "2026-13-01", "2026-00-10", "2026-1-01", "2026-02-3 "]) {
      assert.throws(
        () => createDocument(db, { title: "X", expiryType: "date", expiryDate }),
        /真实日期/,
        expiryDate,
      );
    }
    assert.throws(() => createDocument(db, { title: "X", expiryType: "date", startDate: "0000-01-01" }), /真实日期/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n, 0);
  });
});

test("expiry must not precede start date; equal boundary allowed and update re-validated", () => {
  withDb((db) => {
    assert.throws(
      () => createDocument(db, { title: "X", expiryType: "date", startDate: "2026-01-02", expiryDate: "2026-01-01" }),
      /失效时间不能早于开始日期/,
    );
    const id = createDocument(db, { title: "边界", expiryType: "date", startDate: "2026-01-01", expiryDate: "2026-01-01" });
    assert.equal(getDocument(db, id)!.expiryDate, "2026-01-01");
    assert.throws(
      () => updateDocument(db, id, { title: "X", expiryType: "date", startDate: "2027-01-01", expiryDate: "2026-12-31" }),
      /不能早于/,
    );
    // 校验失败不得改动原记录。
    const after = getDocument(db, id)!;
    assert.equal(after.startDate, "2026-01-01");
    assert.equal(after.expiryDate, "2026-01-01");
  });
});

test("unknown expiryType and invalid duration unit are rejected", () => {
  withDb((db) => {
    const bad: Array<[Parameters<typeof createDocument>[1], RegExp]> = [
      [{ title: "X", expiryType: "months" } as unknown as Parameters<typeof createDocument>[1], /有效期方式无效/],
      [{ title: "X", expiryType: "" } as unknown as Parameters<typeof createDocument>[1], /有效期方式无效/],
      [
        {
          title: "X",
          expiryType: "duration",
          startDate: "2026-01-01",
          durationValue: 5,
          durationUnit: "week",
        } as unknown as Parameters<typeof createDocument>[1],
        /有效期单位无效/,
      ],
    ];
    for (const [input, re] of bad) {
      assert.throws(() => createDocument(db, input as Parameters<typeof createDocument>[1]), re);
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n, 0);
  });
});

test("duration arithmetic overflowing the supported year range is rejected", () => {
  assert.throws(() => addDuration("9999-12-31", 1, "day"), /超出范围/);
  assert.throws(() => addDuration("9999-12-15", 1, "month"), /超出范围/);
  assert.throws(() => addDuration("9999-06-15", 2, "year"), /超出范围/);
  withDb((db) => {
    assert.throws(
      () => createDocument(db, { title: "X", expiryType: "duration", startDate: "9999-12-31", durationValue: 1, durationUnit: "day" }),
      /超出范围/,
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n, 0);
  });
});

test("renaming holder/category to an existing name is rejected; keeping own name allowed", () => {
  withDb((db) => {
    const h1 = createHolder(db, "爸爸");
    createHolder(db, "妈妈");
    const c1 = listCategories(db).find((c) => c.name === "护照")!.id;
    createCategory(db, "会员卡");
    assert.throws(() => renameHolder(db, h1, "妈妈"), /持有人已存在/);
    assert.throws(() => renameCategory(db, c1, "会员卡"), /分类已存在/);
    // 改回自己当前的名字不受唯一约束影响。
    assert.doesNotThrow(() => renameHolder(db, h1, "爸爸"));
    assert.doesNotThrow(() => renameCategory(db, c1, "护照"));
    assert.deepEqual(listHolders(db).map((h) => h.name).sort(), ["妈妈", "爸爸"]);
    assert.ok(listCategories(db).some((c) => c.name === "护照"));
    assert.ok(listCategories(db).some((c) => c.name === "会员卡"));
  });
});

test("failed migration rolls back all DDL and the file can migrate after the obstacle is removed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-db-"));
  const file = path.join(root, "documents.db");
  try {
    // 预置同名表：迁移执行到 CREATE TABLE document_files 时必然失败。
    const obstacle = new Database(file);
    obstacle.exec("CREATE TABLE document_files (id INTEGER PRIMARY KEY)");
    obstacle.close();

    assert.throws(() => openDocumentsDB(undefined, file), /document_files/);

    // 事务回滚：半途创建的 holders/categories/tags/documents/document_tags 必须消失，user_version 保持 0。
    const probe = new Database(file);
    const tables = (probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>).map((r) => r.name);
    assert.deepEqual(tables, ["document_files"]);
    assert.equal(probe.pragma("user_version", { simple: true }), 0);
    probe.exec("DROP TABLE document_files");
    probe.close();

    // 障碍移除后重新打开：迁移完整落地。
    const db = openDocumentsDB(undefined, file);
    try {
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
      assert.equal(listCategories(db).length, DEFAULT_CATEGORIES.length);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("newer schema versions are refused without migrating", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documents-db-"));
  const file = path.join(root, "documents.db");
  try {
    const raw = new Database(file);
    raw.pragma("user_version = 99");
    raw.close();
    assert.throws(() => openDocumentsDB(undefined, file), /版本过高/);
    const probe = new Database(file);
    assert.equal(probe.pragma("user_version", { simple: true }), 99);
    assert.equal(
      (probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n,
      0,
    );
    probe.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
