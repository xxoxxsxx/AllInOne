import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDb, initLedgerSchemaIfNeeded } from "../src/lib/ledger/db.ts";
import { createIssueSelf, createIssueReseller, createReplace, createVoid, getDashboardStats, getEventDetail, getEventProfitSummary } from "../src/lib/ledger/events.ts";

test("shipment void appends an event, preserves accounting, and rejects concurrent/stale requests", async () => {
  const previousDir = process.env.DATA_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-void-"));
  process.env.DATA_DIR = dir;
  try {
    initLedgerSchemaIfNeeded();
    const db = getDb();
    db.prepare("update packages set cost_price = '10.00', sale_price = '20.00' where code = 'plus'").run();
    db.prepare("insert into resellers (code, name) values ('r1', 'R1')").run();
    db.prepare("insert into reseller_package_prices (reseller_code, package_code, supply_price) values ('r1', 'plus', '15.00')").run();
    const common = { occurredAt: "2025-01-01T10:00", note: "original", packageCode: "plus", platformCode: "taobao" };
    const filters = { cdk: "", counterpartyCode: "", dateFrom: "", dateTo: "", note: "", eventType: "" as const, packageCode: "", platformCode: "" };
    async function input(cdk: string) {
      const { id } = db.prepare("select id from events where cdk = ? and event_type in ('issue_self', 'issue_reseller') order by occurred_at desc limit 1").get(cdk) as { id: string };
      const source = (await getEventDetail(id))!;
      return { cdk, note: " optional reason ", occurredAt: "2025-01-02T10:00", shipment: { id, version: source.updated_at ?? source.created_at, occurredAt: source.occurred_at } };
    }
    await createIssueSelf({ ...common, cdk: "SELF" });
    const request = await input("SELF");
    const before = await getEventDetail(request.shipment.id);
    const profit = await getEventProfitSummary(filters);
    const results = await Promise.allSettled([createVoid(request), createVoid(request)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
    assert.deepEqual(await getEventDetail(request.shipment.id), before);
    const after = await getEventProfitSummary(filters);
    assert.equal(after.revenue, profit.revenue);
    assert.equal(after.gross_profit, profit.gross_profit);
    assert.equal(after.product_cost, profit.product_cost);
    assert.equal(after.void_count, 1);
    assert.equal((await getDashboardStats()).activeTotal, 0);
    assert.equal((db.prepare("select note from events where event_type = 'void'").get() as { note: string }).note, "optional reason");

    // A fresh activation must never be voided via the old shipment's button.
    await createIssueSelf({ ...common, occurredAt: "2025-01-03T10:00", cdk: "SELF" });
    await assert.rejects(createVoid({ ...request, occurredAt: "2025-01-04T10:00" }), /后续记录/);
    await createIssueReseller({ ...common, cdk: "RESELLER", counterpartyCode: "r1" });
    await createVoid({ ...await input("RESELLER"), note: "" });

    await createIssueSelf({ ...common, cdk: "REPLACED" });
    const replaced = await input("REPLACED");
    await createReplace({ ...common, occurredAt: "2025-01-02T10:00", oldCdk: "REPLACED", newCdk: "NEW" });
    await assert.rejects(createVoid(replaced), /已作废、换新/);

    await createIssueSelf({ ...common, cdk: "EDITED" });
    const edited = await input("EDITED");
    db.prepare("update events set updated_at = '2025-01-02T00:00:00.000Z' where id = ?").run(edited.shipment.id);
    await assert.rejects(createVoid(edited), /原出货记录已变更/);
    db.prepare("update events set cdk = 'CHANGED' where id = ?").run(edited.shipment.id);
    await assert.rejects(createVoid(edited), /不存在历史记录|已变更/);
    await assert.rejects(createVoid({ ...await input("SELF"), occurredAt: "2025-01-01T10:00" }), /晚于当前时间/);
    await assert.rejects(createVoid({ ...request, shipment: { ...request.shipment, id: "missing" } }), /不存在或不是出货记录/);
  } finally {
    globalThis.__ledgerSqlite?.close();
    globalThis.__ledgerSqlite = undefined;
    globalThis.__ledgerSchemaReady = undefined;
    globalThis.__ledgerStatementCache = undefined;
    globalThis.__ledgerTransactionQueue = undefined;
    if (previousDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
