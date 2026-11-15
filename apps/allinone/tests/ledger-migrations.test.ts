import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getDb, initLedgerSchemaIfNeeded } from "../src/lib/ledger/db.ts";
import { LEDGER_LATEST_VERSION } from "../src/lib/ledger/migrations.ts";
import {
  LEDGER_EVENTS_TABLE_SQL,
  LEDGER_SCHEMA_SQL,
} from "../src/lib/ledger/schema-sql.ts";
import { createIssueSelf, createReplace } from "../src/lib/ledger/events.ts";

// 旧版 events DDL：在现行 DDL 的 replace 分支重新加回 related_cdk 非空约束，
// 用于模拟未迁移的存量库。该子串只出现在 replace 分支。
const legacyEventsDdl = LEDGER_EVENTS_TABLE_SQL.replace(
  "and cdk is not null\n      and counterparty_code is null",
  "and cdk is not null\n      and related_cdk is not null\n      and counterparty_code is null",
);

function resetLedgerGlobals() {
  globalThis.__ledgerSqlite?.close();
  globalThis.__ledgerSqlite = undefined;
  globalThis.__ledgerSchemaReady = undefined;
  globalThis.__ledgerStatementCache = undefined;
  globalThis.__ledgerTransactionQueue = undefined;
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ledger-migration-"));
}

function cleanupLedger(dir: string | undefined) {
  resetLedgerGlobals();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.DATA_DIR;
}

function seedConfig(db: ReturnType<typeof getDb>) {
  db.prepare("insert into packages (code, name, cost_price, sale_price) values ('p1', 'P1', '10.00', '20.00')").run();
  db.prepare("insert into sales_platforms (code, name) values ('s1', 'S1')").run();
}

function getUserVersion(db: ReturnType<typeof getDb>) {
  return db.pragma("user_version", { simple: true }) as number;
}

const common = { occurredAt: "2026-03-01T10:00", note: "", packageCode: "p1", platformCode: "s1" };

test("全新库：基线直建后版本号直接对齐到最新，无需执行迁移", async () => {
  resetLedgerGlobals();
  let dir = process.env.DATA_DIR;
  try {
    initLedgerSchemaIfNeeded();
    const db = getDb();
    assert.equal(getUserVersion(db), LEDGER_LATEST_VERSION);
    const tableSql = (
      db.prepare("select sql from sqlite_master where type = 'table' and name = 'events'").get() as { sql: string }
    ).sql;
    assert.ok(!tableSql.includes("related_cdk is not null"));

    // 基线即最终形态：直接可录入仅作废旧 CDK 的换新。
    seedConfig(db);
    await createIssueSelf({ ...common, cdk: "FRESH-1" });
    await createReplace({ ...common, occurredAt: "2026-03-01T11:00", oldCdk: "FRESH-1", newCdk: "" });
    const row = db
      .prepare("select related_cdk from events where cdk = 'FRESH-1' and event_type = 'replace'")
      .get() as { related_cdk: string | null };
    assert.equal(row.related_cdk, null);
  } finally {
    cleanupLedger(dir);
  }
});

test("旧版严格约束存量库：0008 重建放宽 CHECK、保留数据并升级版本号", async () => {
  resetLedgerGlobals();
  let dir = process.env.DATA_DIR;
  try {
    const db = getDb();
    // 模拟未迁移的存量库：基线 schema + 旧版 events 表（严格 CHECK）+ 存量数据。
    db.exec(LEDGER_SCHEMA_SQL);
    db.exec("drop table events");
    db.exec(legacyEventsDdl);
    seedConfig(db);
    db.prepare(
      "insert into events (id, event_type, occurred_at, package_code, platform_code, cdk, redeemed_at) values ('legacy-e1', 'issue_self', '2026-01-01T00:00:00.000Z', 'p1', 's1', 'LEGACYOLD', '2026-01-01T00:00:00.000Z')",
    ).run();

    initLedgerSchemaIfNeeded();

    assert.equal(getUserVersion(db), LEDGER_LATEST_VERSION);
    const tableSql = (
      db.prepare("select sql from sqlite_master where type = 'table' and name = 'events'").get() as { sql: string }
    ).sql;
    assert.ok(!tableSql.includes("related_cdk is not null"));
    const preserved = db.prepare("select count(*) as count from events where cdk = 'LEGACYOLD'").get() as { count: number };
    assert.equal(preserved.count, 1);

    // 迁移后行为与全新库一致。
    await createReplace({ ...common, oldCdk: "LEGACYOLD", newCdk: "" });
    const row = db
      .prepare("select related_cdk from events where cdk = 'LEGACYOLD' and event_type = 'replace'")
      .get() as { related_cdk: string | null };
    assert.equal(row.related_cdk, null);
  } finally {
    cleanupLedger(dir);
  }
});

test("已放宽但无版本号的存量库：0008 守卫跳过重建，仅对齐版本号", async () => {
  resetLedgerGlobals();
  let dir = process.env.DATA_DIR;
  try {
    const db = getDb();
    // 模拟上一版部署：基线 DDL（已放宽 CHECK）+ 数据，user_version 仍为 0。
    db.exec(LEDGER_SCHEMA_SQL);
    seedConfig(db);
    db.prepare(
      "insert into events (id, event_type, occurred_at, package_code, platform_code, cdk, redeemed_at) values ('e-keep', 'issue_self', '2026-02-01T00:00:00.000Z', 'p1', 's1', 'KEEP-1', '2026-02-01T00:00:00.000Z')",
    ).run();
    const before = db.prepare("select id, created_at from events where cdk = 'KEEP-1'").get() as { id: string; created_at: string };

    initLedgerSchemaIfNeeded();

    assert.equal(getUserVersion(db), LEDGER_LATEST_VERSION);
    const after = db.prepare("select id, created_at from events where cdk = 'KEEP-1'").get() as { id: string; created_at: string };
    assert.deepEqual(after, before);
    const count = db.prepare("select count(*) as count from events").get() as { count: number };
    assert.equal(count.count, 1);
  } finally {
    cleanupLedger(dir);
  }
});
