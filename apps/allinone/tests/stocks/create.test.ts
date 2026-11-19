import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../../src/app/api/stocks/route.ts";
import { openDB, setDB } from "../../src/modules/stocks/store.ts";
import { getStockConfig, listStockConfigs } from "../../src/modules/stocks/api.ts";

test("create API atomically creates normalized stock and range levels, rejects duplicates and rolls back invalid levels", async () => {
  const db = openDB(undefined, ":memory:");
  setDB(db);
  const post = (body: unknown) => POST(new Request("http://localhost/api/stocks", {method:"POST", body:JSON.stringify(body)}));
  try {
    const response = await post({symbol:" msft ", note:"微软", levels:[
      {side:"buy",target:{min:"480",max:"485"},note:"100日均线附近，约24倍PE"},
      {side:"sell",target:{min:"535",max:"550"}}
    ]});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const saved = await response.json();
    assert.equal(saved.symbol, "MSFT");
    assert.equal(saved.enabled, true);
    assert.deepEqual(saved.levels.map((l: {target:string}) => l.target), ["482.5","542.5"]);
    assert.match(saved.levels[0].note, /range 480\.\.485/);
    assert.ok(saved.levels.every((l: {uid:string;enabled:boolean}) => l.uid && l.enabled));
    assert.equal((await post({symbol:"msft",levels:[]})).status,409);
    assert.deepEqual(getStockConfig(db,"MSFT"),saved);
    assert.equal((await post({symbol:"META",levels:[{side:"buy",target:"610"},{side:"invalid",target:"560"}]})).status,400);
    assert.equal(listStockConfigs(db).length,1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM levels").get() as {n:number}).n,2);
    for (const body of [{}, {symbol:"BAD SYMBOL"}, {symbol:"META",enabled:"yes"}, {symbol:"META",extra:1}]) {
      assert.equal((await post(body)).status,400);
    }
    const invalid = await POST(new Request("http://localhost/api/stocks",{method:"POST",body:"{"}));
    assert.equal(invalid.status,400);
    assert.equal((await post({symbol:"META",enabled:false})).status,200);
    assert.equal(getStockConfig(db,"META").enabled,false);
  } finally { setDB(null); db.close(); }
});
