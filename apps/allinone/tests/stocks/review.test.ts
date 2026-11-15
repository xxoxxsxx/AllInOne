import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dueLevels, openDB, SCHEMA_VERSION, setDB, targetGap } from "../../src/modules/stocks/store.ts";
import { levelToggleQuietAction } from "../../src/app/stocks/actions.ts";
import { parseDecimal } from "../../src/modules/stocks/decimal.ts";
import { exportConfig, validateConfig, importConfig } from "../../src/modules/stocks/backup.ts";

test("风险档独立提醒并优先于买入；暂停后恢复普通买入判断", () => {
  const db = openDB(undefined, ":memory:");
  try {
    db.exec(`INSERT INTO stocks(id,symbol) VALUES(1,'RKLB');
      INSERT INTO levels(stock_id,side,target,note,uid) VALUES
      (1,'buy','53.5','轻仓','light'),(1,'buy','46.5','主力','main'),
      (1,'review','40','若中子火箭出现新的技术问题或客户流失，不是加仓机会','risk'),
      (1,'sell','80','中性目标价','sell1'),(1,'sell','120','乐观目标价','sell2');`);
    const hit = (price: string) => dueLevels(db, 1, parseDecimal(price)!).map(l => [l.Side, l.Target]);
    assert.deepEqual(hit('54'), []);
    assert.deepEqual(hit('53.5'), [['buy','53.5']]);
    assert.deepEqual(hit('46.5'), [['buy','46.5']]);
    assert.deepEqual(hit('40'), [['review','40']]);
    assert.deepEqual(hit('39'), [['review','40']]);
    assert.deepEqual(hit('120'), [['sell','120']]);
    assert.match(targetGap('review','40','41'), /下跌/);
    assert.match(targetGap('review','40','39'), /已达目标/);
    db.exec("UPDATE levels SET enabled=0 WHERE side='review'");
    assert.deepEqual(hit('39'), [['buy','46.5']]);
  } finally { db.close(); }
});

test("重新评估档位和备注可备份恢复", () => {
  const db = openDB(undefined, ":memory:");
  const restored = openDB(undefined, ":memory:");
  try {
    db.exec("INSERT INTO stocks(id,symbol) VALUES(1,'RKLB'); INSERT INTO levels(stock_id,side,target,note,uid) VALUES(1,'review','40','技术问题或客户流失时重新评估','risk')");
    const backup = exportConfig(db);
    validateConfig(backup);
    importConfig(restored, backup, "", "");
    assert.deepEqual(restored.prepare("SELECT side,target,note FROM levels").get(), {side:'review',target:'40',note:'技术问题或客户流失时重新评估'});
  } finally { db.close(); restored.close(); }
});

test("概览页暂停按钮页内直接生效：仅切换 enabled，保留提醒额度与档位数据", async () => {
  const db = openDB(undefined, ":memory:");
  setDB(db);
  try {
    db.exec("INSERT INTO stocks(id,symbol) VALUES(1,'MU')");
    db.exec("INSERT INTO levels(id,stock_id,side,target,uid,generation,alerted_generation) VALUES(7,1,'sell','80','toggle-test',4,4)");
    const fd = (action: string) => { const f = new FormData(); f.set("id","1"); f.set("level","7"); f.set("action",action); return f; };
    assert.equal(await levelToggleQuietAction(null, fd("pause")), null);
    const row = () => db.prepare("SELECT enabled,generation,alerted_generation FROM levels WHERE id=7").get() as Record<string, unknown>;
    assert.deepEqual(row(), { enabled: 0, generation: 4, alerted_generation: 4 });
    assert.equal(await levelToggleQuietAction(null, fd("enable")), null);
    assert.deepEqual(row(), { enabled: 1, generation: 4, alerted_generation: 4 });
    const missing = fd("pause"); missing.set("level","999");
    assert.notEqual(await levelToggleQuietAction(null, missing), null); // 不存在的档位返回错误信息
  } finally { setDB(null); db.close(); }
});

test("v20 升级保留档位 ID、UID 和提醒状态并允许风险档", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stocks-review-'));
  let db = openDB(dir);
  try {
    const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE name='levels'").get() as {sql:string}).sql;
    db.exec("DROP TABLE levels");
    db.exec(schema.replace("'buy','sell','review'", "'buy','sell'"));
    db.exec(`INSERT INTO stocks(id,symbol) VALUES(1,'RKLB');
      INSERT INTO levels(id,stock_id,side,target,uid,generation,alerted_generation,last_attempt) VALUES(31,1,'sell','80','stable',3,3,'2026-01-01T00:00:00Z');
      PRAGMA user_version=20;`);
    db.close();
    db = openDB(dir);
    assert.equal(db.pragma('user_version',{simple:true}), SCHEMA_VERSION);
    assert.deepEqual(db.prepare("SELECT id,uid,generation,alerted_generation,last_attempt FROM levels").get(), {id:31,uid:'stable',generation:3,alerted_generation:3,last_attempt:'2026-01-01T00:00:00Z'});
    db.exec("INSERT INTO levels(stock_id,side,target,uid) VALUES(1,'review','40','risk')");
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { if (db.open) db.close(); rmSync(dir,{recursive:true,force:true}); }
});
