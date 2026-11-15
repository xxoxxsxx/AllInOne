import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getDb, initLedgerSchemaIfNeeded } from "../src/lib/ledger/db.ts";
import {
  LEDGER_EVENTS_TABLE_SQL,
  LEDGER_SCHEMA_SQL,
} from "../src/lib/ledger/schema-sql.ts";
import {
  createIssueSelf,
  createReplace,
  getDashboardStats,
  updateEvent,
} from "../src/lib/ledger/events.ts";

// 旧版 events DDL：在现行 DDL 的 replace 分支重新加回 related_cdk 非空约束，
// 用于验证存量库整表重建迁移。该子串只出现在 replace 分支。
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
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ledger-replace-"));
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

test("存量库迁移：重建 events 放宽 CHECK，保留数据并重建索引", async () => {
  resetLedgerGlobals();
  let dir = process.env.DATA_DIR;
  try {
    const db = getDb();
    // 1. 先建全量新 schema，再替换为旧版 events 表，模拟未迁移的存量库。
    db.exec(LEDGER_SCHEMA_SQL);
    db.exec("drop table events");
    db.exec(legacyEventsDdl);
    seedConfig(db);
    db.prepare(
      "insert into events (id, event_type, occurred_at, package_code, platform_code, cdk, redeemed_at) values ('legacy-e1', 'issue_self', '2026-01-01T00:00:00.000Z', 'p1', 's1', 'LEGACYOLD', '2026-01-01T00:00:00.000Z')",
    ).run();

    // 2. 触发初始化：应检测到旧 CHECK 并整表重建。
    initLedgerSchemaIfNeeded();

    const tableSql = (
      db.prepare("select sql from sqlite_master where type = 'table' and name = 'events'").get() as { sql: string }
    ).sql;
    assert.ok(!tableSql.includes("related_cdk is not null"), "迁移后 CHECK 应已放宽");

    const indexNames = (
      db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'events'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    assert.ok(indexNames.includes("events_type_occurred_cdk_unique_idx"), "唯一索引应已重建");

    const preserved = db.prepare("select count(*) as count from events where cdk = 'LEGACYOLD'").get() as { count: number };
    assert.equal(preserved.count, 1, "存量数据应保留");

    // 3. 迁移后允许仅作废旧 CDK 的换新；完成后旧 CDK 不再有效。
    await createReplace({
      occurredAt: "2026-01-02T10:00",
      note: "仅作废",
      packageCode: "p1",
      platformCode: "s1",
      oldCdk: "LEGACYOLD",
      newCdk: "",
    });
    const replaceRow = db
      .prepare("select related_cdk, package_code, platform_code from events where event_type = 'replace'")
      .get() as { related_cdk: string | null; package_code: string; platform_code: string };
    assert.equal(replaceRow.related_cdk, null);
    assert.equal(replaceRow.package_code, "p1");
    assert.equal(replaceRow.platform_code, "s1");

    await assert.rejects(
      createReplace({
        occurredAt: "2026-01-03T10:00",
        note: "",
        packageCode: "p1",
        platformCode: "s1",
        oldCdk: "LEGACYOLD",
        newCdk: "",
      }),
      /旧 CDK 当前不是有效成功记录/,
    );
  } finally {
    cleanupLedger(dir);
  }
});

test("换新：新 CDK 选填，留空仅作废旧 CDK；填写时保持原有互斥校验", async () => {
  resetLedgerGlobals();
  let dir = process.env.DATA_DIR;
  try {
    initLedgerSchemaIfNeeded();
    const db = getDb();
    seedConfig(db);
    const common = { occurredAt: "2026-02-01T10:00", note: "", packageCode: "p1", platformCode: "s1" };

    // 带 新 CDK 的换新：新 CDK 被激活，旧 CDK 失效。
    // 换新时间与发货错开：同毫秒 created_at 时 assertNoLaterRelatedEvents 以 UUID 定序，
    // 会让后续 updateEvent 的「无后续关联事件」检查变成非确定性。
    await createIssueSelf({ ...common, cdk: "OLD-2" });
    await createReplace({ ...common, occurredAt: "2026-02-01T11:00", oldCdk: "OLD-2", newCdk: "NEW-2" });
    await assert.rejects(
      createIssueSelf({ ...common, occurredAt: "2026-02-02T10:00", cdk: "NEW-2" }),
      /该 CDK 已存在有效成功记录/,
      "新 CDK 应处于有效状态",
    );

    // 旧 CDK 与新 CDK 相同仍然拒绝。
    await createIssueSelf({ ...common, occurredAt: "2026-02-03T10:00", cdk: "OLD-3" });
    await assert.rejects(
      createReplace({ ...common, oldCdk: "OLD-3", newCdk: "OLD-3" }),
      /旧 CDK 和新 CDK 不能相同/,
    );

    // 不填 新 CDK：仅作废旧 CDK，related_cdk 为空，旧 CDK 失效。
    await createReplace({ ...common, occurredAt: "2026-02-03T11:00", oldCdk: "OLD-3", newCdk: "" });
    const row = db
      .prepare("select related_cdk from events where cdk = 'OLD-3' and event_type = 'replace'")
      .get() as { related_cdk: string | null };
    assert.equal(row.related_cdk, null);
    await createIssueSelf({ ...common, occurredAt: "2026-02-04T10:00", cdk: "OLD-3" });

    // 详情页编辑：清空新 CDK 视为高风险修改并放行；重复保存无变化返回 false。
    const replaceId = (
      db.prepare("select id from events where cdk = 'OLD-2' and event_type = 'replace'").get() as { id: string }
    ).id;
    const editInput = {
      id: replaceId,
      occurredAt: "2026-02-01T11:00",
      redeemedAt: "",
      packageCode: "p1",
      platformCode: "s1",
      counterpartyCode: "",
      cdk: "OLD-2",
      relatedCdk: "",
      note: "",
      costPrice: "",
      salePrice: "",
      supplyPrice: "",
      platformFeeRatePercent: "",
      platformFeeFixedAmount: "",
      platformFeeAmount: "",
    };
    assert.equal(await updateEvent(editInput), true);
    const cleared = db
      .prepare("select related_cdk from events where id = ?")
      .get(replaceId) as { related_cdk: string | null };
    assert.equal(cleared.related_cdk, null);
    assert.equal(await updateEvent(editInput), false);

    // 编辑时把新 CDK 填成旧 CDK 仍然拒绝。
    await assert.rejects(
      updateEvent({ ...editInput, relatedCdk: "OLD-2" }),
      /旧 CDK 和新 CDK 不能相同/,
    );
  } finally {
    cleanupLedger(dir);
  }
});

test("首页统计：仅作废旧 CDK 的换新会把旧 CDK 计为失效", async () => {
  resetLedgerGlobals();
  let dir = process.env.DATA_DIR;
  try {
    initLedgerSchemaIfNeeded();
    const db = getDb();
    seedConfig(db);
    const dashCommon = { occurredAt: "2026-03-01T10:00", note: "", packageCode: "p1", platformCode: "s1" };

    await createIssueSelf({ ...dashCommon, cdk: "DASH-1" });
    await createIssueSelf({ ...dashCommon, occurredAt: "2026-03-02T10:00", cdk: "DASH-2" });
    await createReplace({ ...dashCommon, occurredAt: "2026-03-03T10:00", oldCdk: "DASH-1", newCdk: "" });

    const stats = await getDashboardStats();
    assert.equal(stats.activeTotal, 1);
    assert.equal(stats.issueSelfActive, 1);
    assert.equal(stats.voidCount, 0);
  } finally {
    cleanupLedger(dir);
  }
});
