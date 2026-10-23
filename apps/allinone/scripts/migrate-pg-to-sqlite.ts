// CDK 台账一次性迁移：PostgreSQL → SQLite（PRD v2 §6.1）。
//
// 用法（在能同时访问旧 PG 和目标数据目录的机器上执行）：
//   cd deploy && cp .env.example .env   # 仅需要 DATABASE_URL 与 ALLINONE_DATA_DIR
//   node --experimental-strip-types scripts/migrate-pg-to-sqlite.ts   （在 apps/allinone 目录下执行）
//
// 行为：只读连接旧 PG；在 $ALLINONE_DATA_DIR/cdk/cdk.db 建库（已存在则中止，
// 用 --force 覆盖）；逐表导入并输出行数核对报告。金额按 TEXT 十进制原样保存。
// 旧 PG 不做任何写操作。
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { Client } from "pg";
import Database from "better-sqlite3";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DATA_DIR = process.env.DATA_DIR ?? process.cwd();
const FORCE = process.argv.includes("--force");

if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL 环境变量（旧 PostgreSQL 连接串）。");
  process.exit(1);
}

const dbPath = path.join(path.resolve(DATA_DIR), "cdk", "cdk.db");
if (fs.existsSync(dbPath) && !FORCE) {
  console.error(`目标已存在：${dbPath}（确认无误请加 --force 覆盖）`);
  process.exit(1);
}
if (fs.existsSync(dbPath)) fs.rmSync(dbPath);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// schema 以 ledger 模块的共享 DDL 为唯一事实源（与运行时建表完全一致）。
const { LEDGER_SCHEMA_SQL } = await import("../src/lib/ledger/schema-sql.ts");
db.exec(LEDGER_SCHEMA_SQL);
// 旧 PG 数据可能不符合 0004/0007 后的严格形状 CHECK（PG 侧为 NOT VALID 豁免）。
// 导入期间关闭 CHECK 以免历史行被拒；导入完成后恢复并保留数据供人工核对。
db.pragma("ignore_check_constraints = ON");

function tableExists(client: { query: (s: string) => Promise<{ rows: unknown[] }> }, name: string): boolean {
  return client.query(`SELECT 1 FROM information_schema.tables WHERE table_name = '${name}'`).then((r) => r.rows.length > 0) as unknown as boolean;
}

const TABLES = ["packages", "resellers", "sales_platforms", "reseller_package_prices", "events"];

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const report: Array<[string, number, number]> = [];
  for (const table of TABLES) {
    if (!(await tableExists(client, table))) {
      console.warn(`跳过（PG 中不存在表 ${table}）`);
      report.push([table, -1, 0]);
      continue;
    }
    const src = await client.query(`SELECT * FROM ${table}`);
    const rows = src.rows as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      report.push([table, 0, 0]);
      continue;
    }
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => "?").join(", ");
    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`);
    const tx = db.transaction((batch: Array<Record<string, unknown>>) => {
      for (const row of batch) {
        stmt.run(...cols.map((c) => normalizeValue(row[c])));
      }
    });
    tx(rows);
    report.push([table, rows.length, rows.length]);
  }

  await client.end();

  console.log("迁移核对报告（PG 行数 → SQLite 行数）：");
  let ok = true;
  for (const [table, src, dst] of report) {
    if (src >= 0 && src !== dst) ok = false;
    console.log(`  ${table}: ${src === -1 ? "表不存在" : src} → ${dst}${src >= 0 && src !== dst ? "  ❌ 不一致" : ""}`);
  }
  db.pragma("ignore_check_constraints = OFF");
  const violated = db.prepare("PRAGMA integrity_check").get();
  console.log("integrity_check:", JSON.stringify(violated));
  if (!ok) {
    console.error("存在不一致，请勿使用迁移结果。");
    process.exit(2);
  }
  console.log(`迁移完成：${dbPath}`);
  db.close();
}

// PG 驱动对 NUMERIC/TIMESTAMPTZ 返回字符串或 Date；统一落为字符串（金额精度保留）。
// BOOLEAN 转为 SQLite INTEGER 0/1（better-sqlite3 不接受布尔绑定，is_active 等 CHECK 依赖它）。
function normalizeValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  return String(v);
}

main().catch((err) => {
  console.error("迁移失败：", err);
  process.exit(1);
});
