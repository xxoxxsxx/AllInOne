import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getDb, initLedgerSchemaIfNeeded } from "../src/lib/ledger/db.ts";
import { createIssueReseller, createIssueSelf } from "../src/lib/ledger/events.ts";

test("录入时保存配置价格和自定义价格快照", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-prices-"));
  process.env.DATA_DIR = dir;
  try {
    initLedgerSchemaIfNeeded();
    const db = getDb();
    db.prepare("insert into packages (code, name, cost_price, sale_price) values ('test-pkg', '套餐', '10.00', '20.00')").run();
    db.prepare("insert into sales_platforms (code, name, fee_rate_percent, fee_fixed_amount) values ('test-platform', '平台', '5', '1.00')").run();
    db.prepare("insert into resellers (code, name) values ('test-reseller', '下游')").run();
    db.prepare("insert into reseller_package_prices (reseller_code, package_code, supply_price) values ('test-reseller', 'test-pkg', '15.00')").run();
    const common = { occurredAt: "2026-01-01T10:00", note: "", packageCode: "test-pkg", platformCode: "test-platform" };
    await createIssueSelf({ ...common, cdk: "DEFAULT" });
    await createIssueSelf({ ...common, cdk: "CUSTOM", costPrice: "0", salePrice: "30", platformFeeRatePercent: "10" });
    await createIssueReseller({ ...common, cdk: "RESELLER", counterpartyCode: "test-reseller", supplyPrice: "25", platformFeeAmount: "9" });
    await createIssueReseller({ ...common, platformCode: "", cdk: "NO-PLATFORM", counterpartyCode: "test-reseller" });
    const row = (cdk: string) => db.prepare("select cost_price, sale_price, supply_price, platform_fee_rate_percent, platform_fee_fixed_amount, platform_fee_amount from events where cdk = ?").get(cdk);
    assert.deepEqual(row("DEFAULT"), { cost_price: "10.00", sale_price: "20.00", supply_price: null, platform_fee_rate_percent: "5", platform_fee_fixed_amount: "1.00", platform_fee_amount: "2.00" });
    assert.deepEqual(row("CUSTOM"), { cost_price: "0.00", sale_price: "30.00", supply_price: null, platform_fee_rate_percent: "10", platform_fee_fixed_amount: "1.00", platform_fee_amount: "4.00" });
    assert.deepEqual(row("RESELLER"), { cost_price: "10.00", sale_price: null, supply_price: "25.00", platform_fee_rate_percent: "5", platform_fee_fixed_amount: "1.00", platform_fee_amount: "9.00" });
    assert.equal((row("NO-PLATFORM") as { platform_fee_amount: string | null }).platform_fee_amount, null);
    await assert.rejects(createIssueSelf({ ...common, cdk: "INVALID", costPrice: "-1" }), /成本价/);
    assert.equal(row("INVALID"), undefined);
  } finally {
    globalThis.__ledgerSqlite?.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  }
});
