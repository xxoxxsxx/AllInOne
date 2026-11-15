import type Database from "better-sqlite3";

import {
  LEDGER_EVENTS_INDEXES_SQL,
  LEDGER_EVENTS_TABLE_SQL,
} from "@/lib/ledger/schema-sql";

// 版本化迁移机制（基线直建 + 编号增量迁移）：
// - 全新库：db.ts 用 schema-sql.ts 的基线 DDL 直建最终形态，版本号直接对齐到 LEDGER_LATEST_VERSION；
// - 存量库：PRAGMA user_version 从 0 开始，按编号顺序逐个执行迁移；每个迁移独立事务，成功后写回版本号。
//
// 约定：
// 1. 新增迁移时追加到 LEDGER_MIGRATIONS 末尾（编号递增），并同步更新 schema-sql.ts 的基线 DDL，
//    保证「新库直建」与「老库迁移到最新」的最终结构一致；
// 2. 每个迁移必须自带守卫、可重复执行（幂等）：版本号写入与 schema 变更不是同一事务，
//    极端情况下迁移可能在写版本号前被中断，重跑时守卫会发现无需再动；
// 3. 需要关外键/整表重建的迁移，pragma 必须在自身事务外执行（事务内 foreign_keys 是 no-op）。

export type LedgerMigration = {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
};

// 0008：旧版 events_shape_valid 要求 replace 的 related_cdk 非空；换新允许仅作废旧 CDK 后
// 需要放宽 CHECK。SQLite 无法修改 CHECK，按官方流程整表重建：
// 关外键 → 事务内建 events_new → 搬数据 → 删旧表 → 改名 → 重建索引 → 外键校验。
function relaxReplaceRelatedCdk(db: Database.Database) {
  const table = db
    .prepare(
      "select sql from sqlite_master where type = 'table' and name = 'events'",
    )
    .get() as { sql: string } | undefined;

  // 守卫：旧约束文本不存在时跳过重建。兼容两种库：
  // - 全新库/基线库（DDL 已是放宽后的最终形态）；
  // - 上一版代码已放宽 CHECK、但还没有版本号的存量库。
  if (!table || !table.sql.includes("related_cdk is not null")) {
    return;
  }

  const eventsNewSql = LEDGER_EVENTS_TABLE_SQL.replace(
    "create table if not exists events",
    "create table events_new",
  );

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      db.exec(eventsNewSql);
      db.exec("insert into events_new select * from events");
      db.exec("drop table events");
      db.exec("alter table events_new rename to events");
      db.exec(LEDGER_EVENTS_INDEXES_SQL);

      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error("events 表重建后外键校验失败。");
      }
    })();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

export const LEDGER_MIGRATIONS: LedgerMigration[] = [
  {
    version: 8,
    name: "放宽 events_shape_valid：换新允许仅作废旧 CDK（related_cdk 可空）",
    up: relaxReplaceRelatedCdk,
  },
];

export const LEDGER_LATEST_VERSION =
  LEDGER_MIGRATIONS[LEDGER_MIGRATIONS.length - 1]?.version ?? 0;
