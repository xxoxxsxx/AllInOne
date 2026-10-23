import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { dataDir } from "@/lib/data-dir";
import { LEDGER_SCHEMA_SQL } from "@/lib/ledger/schema-sql";

export type LedgerQueryResult<T> = {
  rows: T[];
  rowCount: number;
};

export type LedgerQueryFn = <T extends Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<LedgerQueryResult<T>>;

// is_active / is_default 在 PG 里是 boolean，SQLite 用 INTEGER 0/1 承载；
// 按列名在读侧转回 boolean，保持调用方拿到与 pg 驱动一致的布尔值。
const booleanColumns = new Set(["is_active", "is_default"]);

declare global {
  var __ledgerSqlite: Database.Database | undefined;
  var __ledgerSchemaReady: boolean | undefined;
  var __ledgerStatementCache: Map<string, Database.Statement> | undefined;
  var __ledgerTransactionQueue: Promise<unknown> | undefined;
  var __ledgerTransactionContext: AsyncLocalStorage<boolean> | undefined;
}

// All aggregated monetary columns have scale 2; use integer cents without floating point.
function decimalUnits(value: string): bigint {
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("Invalid monetary decimal stored in ledger.");
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const units = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return negative ? -units : units;
}

function decimalText(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}

function context() {
  return globalThis.__ledgerTransactionContext ??= new AsyncLocalStorage<boolean>();
}

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const queued = (globalThis.__ledgerTransactionQueue ?? Promise.resolve()).then(run);
  globalThis.__ledgerTransactionQueue = queued.catch(() => {});
  return queued;
}

function getDbPath() {
  return path.join(dataDir(), "cdk", "cdk.db");
}

function openDatabase(): Database.Database {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.function("decimal_neg", (value) => value === null ? null : decimalText(-decimalUnits(String(value))));
  db.function("decimal_add", (a, b) => decimalText(decimalUnits(String(a)) + decimalUnits(String(b))));
  db.function("decimal_sub", (a, b) => decimalText(decimalUnits(String(a)) - decimalUnits(String(b))));
  db.aggregate("decimal_sum", {
    start: "0.00",
    step: (total: string, value: unknown) => decimalText(decimalUnits(total) + (value === null ? BigInt(0) : decimalUnits(String(value)))),
  });

  return db;
}

export function getDb() {
  if (!globalThis.__ledgerSqlite) {
    globalThis.__ledgerSqlite = openDatabase();
  }

  return globalThis.__ledgerSqlite;
}

// 把 7 个 PG 迁移拍平为一份 SQLite DDL（见 schema-sql.ts 的迁移对照注释）。
export function ensureLedgerSchema() {
  const db = getDb();
  db.exec(LEDGER_SCHEMA_SQL);
}

// 供调用方在启动时调用；进程内只建一次。
export function initLedgerSchemaIfNeeded() {
  if (!globalThis.__ledgerSchemaReady) {
    ensureLedgerSchema();
    seedLedgerDefaultsIfEmpty();
    globalThis.__ledgerSchemaReady = true;
  }
}

// seeds/0001_base.sql 语义：空库时注入默认套餐与售卖平台（plus / taobao 为默认项，
// 当前没有默认下游对象，resellers 保留空表）。
export function seedLedgerDefaultsIfEmpty() {
  const db = getDb();
  const hasAnyConfig = db.prepare("select 1 from packages limit 1").get()
    || db.prepare("select 1 from sales_platforms limit 1").get()
    || db.prepare("select 1 from resellers limit 1").get();

  if (hasAnyConfig) {
    return;
  }

  const insertPackage = db.prepare(
    "insert into packages (code, name, sort_order, is_default) values (?, ?, ?, ?)",
  );
  const insertPlatform = db.prepare(
    "insert into sales_platforms (code, name, sort_order, is_default) values (?, ?, ?, ?)",
  );

  db.transaction(() => {
    insertPackage.run("plus", "Plus", 10, 1);
    insertPackage.run("5xpro", "5xpro", 20, 0);
    insertPackage.run("20xpro", "20xpro", 30, 0);
    insertPlatform.run("taobao", "淘宝", 10, 1);
    insertPlatform.run("xianyu", "闲鱼", 20, 0);
    insertPlatform.run("pinduoduo", "拼多多", 30, 0);
  })();
}

// Repeated/out-of-order PG placeholders must duplicate/reorder the bound values.
function toSqliteSql(text: string, values: unknown[]) {
  const bindings: unknown[] = [];
  const timestamped = text.replace(/\b(update\s+(?:events|packages|resellers|sales_platforms|reseller_package_prices)\s+set|do\s+update\s+set)\b/gi, "$1 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),");
  const sql = timestamped.replace(/\$(\d+)/g, (_match, index: string) => {
    const position = Number(index);
    if (position < 1 || position > values.length) throw new Error(`无效的占位符：$${index}`);
    bindings.push(values[position - 1]);
    return "?";
  });
  return { sql, bindings: bindings.length ? bindings : values };
}

function toBindValue(value: unknown) {
  if (value === undefined) {
    return null;
  }

  // 代码里的布尔入参（is_active = $2 等）绑定为 0/1。
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function mapRow<T extends Record<string, unknown>>(row: T): T {
  const mutable = row as Record<string, unknown>;

  for (const key of Object.keys(mutable)) {
    if (booleanColumns.has(key) && typeof mutable[key] === "number") {
      mutable[key] = mutable[key] === 1;
    }
  }

  return row;
}

// 复刻 pg 驱动的错误形状（code / constraint 字段），调用方按 23505 判断唯一冲突。
class LedgerSqliteError extends Error {
  code: string;
  constraint?: string;

  constructor(code: string, message: string, constraint?: string) {
    super(message);
    this.name = "LedgerSqliteError";
    this.code = code;
    this.constraint = constraint;
  }
}

const uniqueConstraintRegex = /^UNIQUE constraint failed: (.+)$/;
const checkConstraintRegex = /^CHECK constraint failed: (.+)$/;
// events_type_occurred_cdk_unique_idx（0002 迁移，CDK 去重）是库里唯一的业务唯一索引；
// SQLite 对索引冲突只报列名，这里映射回 PG 时代的约束名。
const dedupUniqueColumns = "events.event_type, events.occurred_at, events.cdk";

function mapSqliteError(error: unknown) {
  if (error instanceof LedgerSqliteError) {
    return error;
  }

  if (error instanceof Error) {
    const uniqueMatch = uniqueConstraintRegex.exec(error.message);

    if (uniqueMatch) {
      const columns = uniqueMatch[1];
      const isDedupIndex = columns === dedupUniqueColumns;

      return new LedgerSqliteError(
        "23505",
        isDedupIndex
          ? 'duplicate key value violates unique constraint "events_type_occurred_cdk_unique_idx"'
          : `duplicate key value violates unique constraint "${columns}"`,
        isDedupIndex ? "events_type_occurred_cdk_unique_idx" : columns,
      );
    }

    const checkMatch = checkConstraintRegex.exec(error.message);

    if (checkMatch) {
      const constraint = checkMatch[1].trim();

      return new LedgerSqliteError(
        "23514",
        `new row for relation violates check constraint "${constraint}"`,
        constraint,
      );
    }

    if (error.message === "FOREIGN KEY constraint failed") {
      return new LedgerSqliteError("23503", error.message);
    }
  }

  return error;
}

function getCachedStatement(db: Database.Database, sqliteSql: string) {
  if (!globalThis.__ledgerStatementCache) {
    globalThis.__ledgerStatementCache = new Map();
  }

  const cache = globalThis.__ledgerStatementCache;
  const cached = cache.get(sqliteSql);

  if (cached) {
    return cached;
  }

  const statement = db.prepare(sqliteSql);
  cache.set(sqliteSql, statement);

  return statement;
}

// 保持 PG 风格签名（$n 占位符 + { rows, rowCount } 返回），内部转译为 SQLite。
// better-sqlite3 的执行是同步的，async 仅用于兼容调用方的 await 用法。
async function executeQuery<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<LedgerQueryResult<T>> {
  initLedgerSchemaIfNeeded();
  const db = getDb();
  const { sql, bindings } = toSqliteSql(text, values);
  const statement = getCachedStatement(db, sql);
  const bindValues = bindings.map(toBindValue);

  try {
    if (statement.reader) {
      const rows = (statement.all(...bindValues) as Record<string, unknown>[])
        .map((row) => mapRow<Record<string, unknown>>(row));

      return {
        rows: rows as T[],
        rowCount: rows.length,
      };
    }

    const result = statement.run(...bindValues);

    return {
      rows: [],
      rowCount: Number(result.changes),
    };
  } catch (error) {
    throw mapSqliteError(error);
  }
}

export async function dbQuery<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<LedgerQueryResult<T>> {
  if (context().getStore()) return executeQuery<T>(text, values);
  return enqueue(() => executeQuery<T>(text, values));
}

// better-sqlite3.transaction cannot wrap an async callback: it commits before await.
// Serialize all connection access, and let queries in the transaction context bypass
// the queue (including helpers that call dbQuery rather than the supplied query).
export function withTransaction<T>(run: (query: LedgerQueryFn) => Promise<T>): Promise<T> {
  if (context().getStore()) return Promise.reject(new Error("Nested ledger transactions are unsupported."));
  return enqueue(() => context().run(true, async () => {
    initLedgerSchemaIfNeeded();
    const db = getDb();
    db.exec("begin immediate");
    try {
      const result = await run(dbQuery);
      db.exec("commit");
      return result;
    } catch (error) {
      if (db.inTransaction) db.exec("rollback");
      throw mapSqliteError(error);
    }
  }));
}
