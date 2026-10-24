import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDB, reserveQuoteCall, getQuotaStatus } from "../../src/modules/stocks/store.ts";
import { withQuoteQuota, QuotaError, QueryCancelled } from "../../src/modules/stocks/quota.ts";
import { RateLimitError } from "../../src/modules/stocks/quote.ts";

function clock() {
  let time=Date.UTC(2026,9,26,15);
  return { now:()=>new Date(time), sleep:async(ms:number)=>{time+=ms;}, advance:(ms:number)=>{time+=ms;} };
}
test("20 concurrent quotes share FIFO quota and complete in 8+8+4 batches",async()=>{
  const db=openDB(undefined,":memory:"), c=clock(), times:number[]=[];
  try {
    await Promise.all(Array.from({length:20},()=>withQuoteQuota(db,async()=>{times.push(c.now().getTime());},c)));
    assert.equal(times.filter(t=>t===times[0]).length,8);
    assert.equal(times.filter(t=>t===times[0]+61000).length,8);
    assert.equal(times.filter(t=>t===times[0]+122000).length,4);
    assert.equal(getQuotaStatus(db,c.now()).dayUsed,20);
  } finally {db.close();}
});
test("daily budget is enforced and minute/day records survive reopen",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"quota-test-")), c=clock();
  let db=openDB(dir);
  try {
    db.prepare('UPDATE settings SET quota_per_day=2').run();
    assert.equal(reserveQuoteCall(db,c.now()).ok,true);
    assert.equal(reserveQuoteCall(db,c.now()).ok,true);
    db.close(); db=openDB(dir);
    assert.equal(getQuotaStatus(db,c.now()).dayUsed,2);
    await assert.rejects(withQuoteQuota(db,async()=>{assert.fail('must not request');},c),QuotaError);
    c.advance(86400001);
    assert.equal(reserveQuoteCall(db,c.now()).ok,true);
  } finally {db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test("429 establishes shared cooldown and bounded retries consume credits",async()=>{
  const db=openDB(undefined,":memory:"), c=clock(), initial=c.now().getTime();let attempts=0;
  try {
    await assert.rejects(withQuoteQuota(db,async()=>{attempts++;throw new RateLimitError(0);},c),RateLimitError);
    assert.equal(attempts,2);
    assert.equal(c.now().getTime()-initial,61000);
    let requestedAt=0;
    await withQuoteQuota(db,async()=>{requestedAt=c.now().getTime();},c);
    assert.equal(requestedAt-initial,122000);
    assert.equal(getQuotaStatus(db,c.now()).dayUsed,3);
  }finally{db.close();}
});
test("eligibility is rechecked during wait without consuming another credit",async()=>{
  const db=openDB(undefined,":memory:"), c=clock();let enabled=true;
  try {
    for(let i=0;i<8;i++) reserveQuoteCall(db,c.now());
    await assert.rejects(withQuoteQuota(db,async()=>{assert.fail('disabled request');},{...c,eligible:()=>enabled?null:'股票停用',sleep:async(ms)=>{await c.sleep(ms);enabled=false;}}),QueryCancelled);
    assert.equal(getQuotaStatus(db,c.now()).dayUsed,8);
  } finally {db.close();}
});

import { createRun, listStocks, getRunProgress, getRun } from "../../src/modules/stocks/store.ts";
import { runOnce, startManualRun, resetRunningLock } from "../../src/modules/stocks/run.ts";
import { parseDecimal } from "../../src/modules/stocks/decimal.ts";
const quote = (symbol:string) => ({Symbol:symbol,Price:parseDecimal("10")!,Open:"",PrevClose:"",At:new Date(),Source:"test",TimeField:"last_quote_at",Delay:"",AssetOK:false});

test("run finishes 20 symbols rather than skipping the ninth, with persisted progress",async()=>{
 const db=openDB(undefined,":memory:"),c=clock();
 try {
  for(let i=0;i<20;i++) db.prepare('INSERT INTO stocks(symbol) VALUES(?)').run(`S${i}`);
  const stocks=listStocks(db),id=createRun(db,stocks,'manual',0,'','');
  let fetched=0,waiting=false;
  await runOnce(db,id,stocks,async symbol=>{fetched++;return quote(symbol);},'Asia/Shanghai',{...c,onWait:until=>{if(until){waiting=true;assert.ok(getRunProgress(db,id).pending>0);}}});
  assert.equal(fetched,20);assert.equal(waiting,true);
  assert.equal(getRunProgress(db,id).completed,20);
  assert.equal(getRun(db,id)?.results.every(r=>r.Status==='ok'),true);
 }finally{db.close();resetRunningLock();}
});
test("repeated manual starts reuse active run and request only once",async()=>{
 const db=openDB(undefined,":memory:");let unblock!:()=>void;
 try{
  db.prepare("UPDATE settings SET api_key='test'").run();db.prepare("INSERT INTO stocks(symbol) VALUES('AAA')").run();
  let calls=0;const gate=new Promise<void>(r=>{unblock=r;});
  const provider=async(symbol:string)=>{calls++;await gate;return quote(symbol);};
  const first=startManualRun(db,'Asia/Shanghai',provider);
  const second=startManualRun(db,'Asia/Shanghai',provider);
  if (!first.ok || !second.ok) throw new Error('startManualRun failed');
  assert.deepEqual(first,{ok:true,id:first.id,reused:false});
  assert.deepEqual(second,{ok:true,id:first.id,reused:true});await Promise.resolve();await Promise.resolve();unblock();
  await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 }finally{unblock?.();db.close();resetRunningLock();}
});
