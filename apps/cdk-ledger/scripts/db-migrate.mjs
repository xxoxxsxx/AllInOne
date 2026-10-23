import { createClient, readSqlFiles } from "./db-utils.mjs";

async function tableExists(client, tableName) {
  const result = await client.query(
    "select to_regclass($1) is not null as exists",
    ["public." + tableName],
  );
  return result.rows[0].exists;
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `select 1
     from information_schema.columns
     where table_schema = 'public'
       and table_name = $1
       and column_name = $2`,
    [tableName, columnName],
  );
  return result.rowCount > 0;
}

export async function markApplied(client, name) {
  await client.query(
    `insert into schema_migrations(name) values ($1)
     on conflict (name) do nothing`,
    [name],
  );
}

async function ensureHistory(client, files) {
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  if (!(await tableExists(client, "events"))) {
    return files.map((file) => file.name);
  }

  const names = files.map((file) => file.name);
  const appliedRows = await client.query(
    "select name from schema_migrations where name = any($1)",
    [names],
  );
  const applied = new Set(appliedRows.rows.map((row) => row.name));

  // Existing deployments predate migration history. Detect the schema baseline
  // so startup migration does not replay statements that are not idempotent.
  if (await columnExists(client, "events", "cost_price")) {
    for (const file of files) {
      if (file.name < "0007_refunds.sql" && !applied.has(file.name)) {
        await markApplied(client, file.name);
        applied.add(file.name);
      }
    }
  }

  if (await columnExists(client, "events", "source_event_id")) {
    for (const file of files) {
      if (!applied.has(file.name)) {
        await markApplied(client, file.name);
        applied.add(file.name);
      }
    }
  }

  return files.filter((file) => !applied.has(file.name)).map((file) => file.name);
}

export async function runMigrations(options = {}) {
  const requested = options.requested ?? process.argv.slice(2);
  const allFiles = readSqlFiles("db/migrations");
  for (const name of requested) {
    if (!allFiles.some((file) => file.name === name)) {
      throw new Error(`Unknown migration: ${name}`);
    }
  }

  const client = createClient();
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    let pending;
    if (requested.length) {
      const files = allFiles.filter((file) => requested.includes(file.name));
      pending = files.map((file) => file.name);
    } else {
      pending = await ensureHistory(client, allFiles);
    }

    for (const name of pending) {
      const file = allFiles.find((item) => item.name === name);
      process.stdout.write(`Applying migration ${file.name}...\n`);
      await client.query(file.sql);
      await markApplied(client, file.name);
    }
  } finally {
    await client.end();
  }

  process.stdout.write("Migrations complete.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
