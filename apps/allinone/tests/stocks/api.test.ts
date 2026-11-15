import assert from "node:assert/strict";
import { test } from "node:test";
import { getStockConfig, listStockConfigs, patchStockConfig, StocksAPIError } from "../../src/modules/stocks/api.ts";
import { openDB, setDB, dueLevels } from "../../src/modules/stocks/store.ts";
import { parseDecimal } from "../../src/modules/stocks/decimal.ts";
import { GET as listGET } from "../../src/app/api/stocks/route.ts";
import { GET, PATCH } from "../../src/app/api/stocks/[symbol]/route.ts";

function fixture() {
  const db = openDB(undefined, ":memory:");
  db.prepare("INSERT INTO stocks(symbol,note) VALUES('AAPL','apple'),('MSFT','microsoft')").run();
  return db;
}
function status(code: number) { return (e: unknown) => e instanceof StocksAPIError && e.status === code; }

test("config reads exclude secrets and live counters; revision tracks configuration only", () => {
  const db = fixture();
  try {
    const first = patchStockConfig(db, "aapl", { levels: [{ uid: "one", side: "buy", target: "100" }] });
    db.prepare("UPDATE settings SET api_key='secret',tg_token='secret'").run();
    db.prepare("UPDATE levels SET generation=20,alerted_generation=20,last_attempt='now'").run();
    assert.deepEqual(getStockConfig(db, "AAPL"), first);
    assert.ok(!JSON.stringify(first).includes("secret"));
    assert.ok(!("generation" in first.levels[0]));
    const list = listStockConfigs(db);
    assert.deepEqual(list.map(s => s.symbol), ["AAPL", "MSFT"]);
    assert.equal(list[0].level_count, 1);
    assert.ok(!("levels" in list[0]));
    assert.notEqual(patchStockConfig(db, "AAPL", { note: "changed" }).revision, first.revision);
  } finally { db.close(); }
});

test("explicit upserts preserve omitted levels, UID retry is idempotent, conflicts roll back", () => {
  const db = fixture();
  try {
    assert.throws(() => patchStockConfig(db, "AAPL", { levels: [{ side: "buy", target: "100" }] }), status(428));
    const body = { levels: [{ uid: "buy-one", side: "buy", target: "100" }, { uid: "sell-one", side: "sell", target: "200" }] };
    const first = patchStockConfig(db, "AAPL", body);
    assert.deepEqual(patchStockConfig(db, "AAPL", body), first);
    assert.throws(() => patchStockConfig(db, "AAPL", { levels: [{ uid: "buy-one", side: "buy", target: "101" }] }), status(409));
    assert.throws(() => patchStockConfig(db, "MSFT", { levels: [{ id: first.levels[0].id, target: "10" }] }), status(400));
    assert.throws(() => patchStockConfig(db, "MSFT", { delete_level_ids: [first.levels[0].id] }), status(400));
    assert.throws(() => patchStockConfig(db, "AAPL", { note: "rollback", levels: [{ id: first.levels[0].id, target: "99" }, { uid: "invalid", side: "bad", target: "3" }] }), status(400));
    assert.deepEqual(getStockConfig(db, "AAPL"), first);
    const changed = patchStockConfig(db, "AAPL", { revision: first.revision, levels: [{ id: first.levels[0].id, target: "99" }] });
    assert.equal(changed.levels[1].target, "200");
    assert.throws(() => patchStockConfig(db, "AAPL", { revision: first.revision, note: "stale" }), status(409));
    assert.equal(patchStockConfig(db, "AAPL", { delete_level_ids: [changed.levels[1].id] }).levels.length, 1);
    const beforeCreate = getStockConfig(db, "AAPL");
    const create = { revision: beforeCreate.revision, levels: [{ side: "buy", target: "98" }] };
    assert.equal(patchStockConfig(db, "AAPL", create).levels.length, 2);
    assert.throws(() => patchStockConfig(db, "AAPL", create), status(409));
  } finally { db.close(); }
});

test("range midpoint is exact, retained in note, and review hits at or below target", () => {
  const db = fixture();
  try {
    const result = patchStockConfig(db, "AAPL", { levels: [{ uid: "review", side: "review", target: { min: "0.1000", max: "0.1002" }, note: "risk" }] });
    assert.equal(result.levels[0].target, "0.1001");
    assert.equal(result.levels[0].note, "risk [range 0.1..0.1002]");
    assert.equal(result.levels[0].side, "review");
    assert.equal(dueLevels(db, result.id, parseDecimal("0.1001")!)[0].Side, "review");
    assert.equal(dueLevels(db, result.id, parseDecimal("0.1002")!).length, 0);
    for (const target of [{ min: "0.1", max: "0.1001" }, { min: "2", max: "1" }, { min: 1, max: "2" }, "1e2", "0", "1.00001"]) {
      assert.throws(() => patchStockConfig(db, "AAPL", { levels: [{ uid: "bad", side: "buy", target }] }), status(400));
    }
    assert.throws(() => patchStockConfig(db, "AAPL", { levels: [{ uid: "long", side: "buy", target: { min: "1", max: "2" }, note: "x".repeat(200) }] }), status(400));
    assert.equal(getStockConfig(db, "AAPL").revision, result.revision);
  } finally { db.close(); }
});

test("HTTP routes return config JSON, useful errors and no-store without authentication", async () => {
  const db = fixture();
  setDB(db);
  const context = { params: Promise.resolve({ symbol: "AAPL" }) };
  try {
    const list = await listGET();
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.equal((await list.json()).stocks.length, 2);
    const detail = await GET(new Request("http://localhost/api/stocks/AAPL"), context);
    assert.equal((await detail.json()).symbol, "AAPL");
    const patch = (body: string) => PATCH(new Request("http://localhost/api/stocks/AAPL", { method: "PATCH", body }), context);
    assert.equal((await patch("{" )).status, 400);
    assert.equal((await patch(JSON.stringify({ enabled: "false" }))).status, 400);
    const ok = await patch(JSON.stringify({ levels: [{ uid: "http", side: "sell", target: "200" }] }));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).levels.length, 1);
    const missing = await GET(new Request("http://localhost/api/stocks/NONE"), { params: Promise.resolve({ symbol: "NONE" }) });
    assert.equal(missing.status, 404);
    assert.equal((await patch(JSON.stringify({ revision: "stale" }))).status, 409);
  } finally { setDB(null); db.close(); }
});
