import { createClient } from "./db-utils.mjs";

const requiredTables = [
  "events",
  "packages",
  "resellers",
  "sales_platforms",
  "reseller_package_prices",
];
const requiredIndexes = [
  "events_source_event_idx",
  "events_occurred_at_idx",
  "events_event_type_idx",
  "events_type_occurred_cdk_unique_idx",
  "events_package_code_idx",
  "events_counterparty_code_idx",
  "events_cdk_idx",
  "events_related_cdk_idx",
  "events_redeemed_at_idx",
  "packages_active_sort_idx",
  "resellers_active_sort_idx",
  "sales_platforms_active_sort_idx",
  "reseller_package_prices_package_idx",
];

async function assertTables(client) {
  const { rows } = await client.query(
    `
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
    `,
    [requiredTables],
  );

  const found = new Set(rows.map((row) => row.table_name));
  const missing = requiredTables.filter((name) => !found.has(name));

  if (missing.length > 0) {
    throw new Error(`Missing tables: ${missing.join(", ")}`);
  }
}

async function assertEventColumns(client) {
  const { rows } = await client.query(`
    select column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'events'
      and column_name = any($1::text[])
  `, [[
    "source_event_id",
    "refund_amount",
    "cost_returned",
    "fee_returned",
    "created_at",
    "updated_at",
    "redeemed_at",
    "cost_price",
    "sale_price",
    "supply_price",
    "platform_fee_rate_percent",
    "platform_fee_fixed_amount",
    "platform_fee_amount",
  ]]);

  const columns = Object.fromEntries(
    rows.map((row) => [row.column_name, row.is_nullable]),
  );

  if (columns.created_at !== "NO") {
    throw new Error("events.created_at must be NOT NULL");
  }

  if (columns.updated_at !== "YES") {
    throw new Error("events.updated_at must allow NULL");
  }

  if (columns.redeemed_at !== "YES") {
    throw new Error("events.redeemed_at must allow NULL");
  }

  for (const column of [
    "source_event_id",
    "refund_amount",
    "cost_returned",
    "fee_returned",
    "cost_price",
    "sale_price",
    "supply_price",
    "platform_fee_rate_percent",
    "platform_fee_fixed_amount",
    "platform_fee_amount",
  ]) {
    if (!(column in columns)) {
      throw new Error(`Missing events column: ${column}`);
    }
  }
}

async function assertPricingColumns(client) {
  const { rows } = await client.query(`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and (
        (table_name = 'packages' and column_name = any($1::text[]))
        or (table_name = 'sales_platforms' and column_name = any($2::text[]))
      )
  `, [["cost_price", "sale_price"], ["fee_rate_percent", "fee_fixed_amount"]]);

  const found = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  const required = [
    "packages.cost_price",
    "packages.sale_price",
    "sales_platforms.fee_rate_percent",
    "sales_platforms.fee_fixed_amount",
  ];
  const missing = required.filter((column) => !found.has(column));

  if (missing.length > 0) {
    throw new Error(`Missing pricing columns: ${missing.join(", ")}`);
  }
}

async function assertIndexes(client) {
  const { rows } = await client.query(
    `
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname = any($1::text[])
    `,
    [requiredIndexes],
  );

  const found = new Set(rows.map((row) => row.indexname));
  const missing = requiredIndexes.filter((name) => !found.has(name));

  if (missing.length > 0) {
    throw new Error(`Missing indexes: ${missing.join(", ")}`);
  }
}

async function main() {
  const client = createClient();
  await client.connect();

  try {
    await assertTables(client);
    await assertEventColumns(client);
    await assertPricingColumns(client);
    await assertIndexes(client);
  } finally {
    await client.end();
  }

  process.stdout.write("Database structure check passed.\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
