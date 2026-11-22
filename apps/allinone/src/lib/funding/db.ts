import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/data-dir";
export function openFundingDB(file = ":memory:"): Database.Database {
  if (file !== ":memory:")
    fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    const version = Number(db.pragma("user_version", { simple: true }));
    if (version > 3)
      throw new Error("funding database version is newer than supported");
    db.exec(`CREATE TABLE IF NOT EXISTS funding_entities (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection,id));
    CREATE TABLE IF NOT EXISTS funding_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS funding_idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
    `);
    if (version < 2) {
      db.exec(
        "ALTER TABLE funding_changes ADD COLUMN source TEXT NOT NULL DEFAULT 'api'; ALTER TABLE funding_changes ADD COLUMN before_data TEXT; PRAGMA user_version = 2;",
      );
    }
    if (version < 3) {
      db.exec(
        `WITH numbered AS MATERIALIZED (
          SELECT id, row_number() OVER (
            ORDER BY coalesce(json_extract(data, '$.confirmedAt'), json_extract(data, '$.occurredAt')),
                     json_extract(data, '$.occurredAt'), rowid
          ) AS number
          FROM funding_entities
          WHERE collection = 'transfers'
            AND json_extract(data, '$.kind') = 'broker'
            AND json_extract(data, '$.status') = 'confirmed'
        )
        UPDATE funding_entities
        SET data = json_set(data, '$.number', numbered.number)
        FROM numbered
        WHERE funding_entities.collection = 'transfers' AND funding_entities.id = numbered.id;
        PRAGMA user_version = 3;`,
      );
    }
  }).immediate();
  return db;
}
declare global {
  var __fundingSqlite: Database.Database | undefined;
}
export function getFundingDB() {
  return (globalThis.__fundingSqlite ??= openFundingDB(
    path.join(dataDir(), "funding", "funding.db"),
  ));
}
