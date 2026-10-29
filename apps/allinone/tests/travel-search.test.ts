// 高德搜索后端单测：fetch 注入，验证清洗/错误/超时/缓存/限流/Key 安全。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAmapSearch, parseAmapPlaceText, AMAP_ATTRIBUTION } from "../src/lib/travel/search.ts";
import { getAmapKey, getAmapSettingsStatus, openTravelDB, saveAmapKey } from "../src/lib/travel/db.ts";

const amapOk = (pois: unknown[]) => ({ status: "1", info: "OK", infocode: "10000", pois });
const poi = (id: string, name: string, lat: number, lng: number, address = "") => ({ id, name, address, location: `${lng},${lat}` });

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

test("search returns cleaned places and hides key/url on upstream errors", async () => {
  const calls: string[] = [];
  const search = createAmapSearch({
    getKey: () => "a".repeat(32),
    fetchImpl: (input) => {
      calls.push(String(input));
      return Promise.resolve(mockFetchResponse({ status: "0", info: "INVALID_USER_KEY", infocode: "10001" }));
    },
    sleep: async () => {},
  });
  const result = await search("太平山顶", "香港");
  assert.equal(result.status, 400);
  assert.match(result.error!, /Key 无效或未开通搜索权限/);
  assert.ok(!result.error!.includes("a".repeat(32)));
  assert.ok(!calls[0].includes("NONEXIST"), "no weird url");
  assert.ok(calls[0].startsWith("https://restapi.amap.com/v3/place/text"));
  assert.ok(calls[0].includes("keywords=" + encodeURIComponent("太平山顶")));
  assert.ok(calls[0].includes("offset=10"));
  assert.ok(calls[0].includes("page=1"));
  assert.ok(calls[0].includes("extensions=base"));
  assert.ok(calls[0].includes("citylimit=true"));
  assert.ok(calls[0].includes("city=" + encodeURIComponent("香港")));
});

test("successful search cleans coordinates, attribution present, junk pois dropped", async () => {
  const search = createAmapSearch({
    getKey: () => "b".repeat(32),
    fetchImpl: async () => mockFetchResponse(amapOk([
      poi("B00156ABCDEF", "太平山顶", 22.2695, 114.1502, "山顶道"),
      poi("BAD", "", 0, 0), // 无名称 → 丢弃
      { id: "B002", name: "坏坐标", location: "abc,def" }, // 坏坐标 → 丢弃
      { id: "B003", name: "越界", location: "999,9999" }, // 越界 → 丢弃
      poi("B004", "零点", 0, 0, "原点"), // 0,0 → 丢弃
      poi("B005", "第九个", 22.1, 114.0),
    ])),
    sleep: async () => {},
  });
  const result = await search("山顶", "香港");
  assert.equal(result.status, 200);
  assert.equal(result.places.length, 2);
  assert.deepEqual(result.places[0], { id: "B00156ABCDEF", name: "太平山顶", address: "山顶道", lat: 22.2695, lng: 114.1502 });
  assert.equal(result.attribution, AMAP_ATTRIBUTION);
});

test("quota / permission amap errors are mapped to friendly Chinese messages", async () => {
  const search = createAmapSearch({
    getKey: () => "c".repeat(32),
    fetchImpl: async () => mockFetchResponse({ status: "0", info: "CUQ_HAS_EXCEEDED_THE_LIMIT", infocode: "10044" }),
    sleep: async () => {},
  });
  const quota = await search("铜锣湾", "香港");
  assert.match(quota.error!, /配额/);
  const perm = createAmapSearch({
    getKey: () => "d".repeat(32),
    fetchImpl: async () => mockFetchResponse({ status: "0", info: "DAILY_QUERY_OVER_LIMIT", infocode: "10021" }),
    sleep: async () => {},
  });
  const over = await perm("尖沙咀", "香港");
  assert.match(over.error!, /配额|Key 无效/);
});

test("http 429 maps to 429 and upstream 500 maps to 502 without leaking details", async () => {
  const search = createAmapSearch({
    getKey: () => "e".repeat(32),
    fetchImpl: async () => new Response("upstream boom", { status: 500 }),
    sleep: async () => {},
  });
  const r = await search("旺角", "香港");
  assert.equal(r.status, 502);
  assert.ok(!r.error!.includes("upstream boom"));
  const rate = createAmapSearch({
    getKey: () => "f".repeat(32),
    fetchImpl: async () => new Response("slow down", { status: 429 }),
    sleep: async () => {},
  });
  const r429 = await rate("旺角", "香港");
  assert.equal(r429.status, 429);
});

test("upstream timeout returns 504 friendly message", async () => {
  const search = createAmapSearch({
    getKey: () => "0".repeat(32),
    fetchImpl: ((_input: RequestInfo, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as unknown as typeof fetch,
    sleep: async () => {},
  });
  const r = await search("中环", "香港");
  assert.equal(r.status, 504);
  assert.match(r.error!, /超时/);
});

test("responses cached for 5 minutes and rate limited to >=500ms between upstream calls", async () => {
  let clock = 1_000_000;
  let upstreamCalls = 0;
  const search = createAmapSearch({
    getKey: () => "1".repeat(32),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: () => { upstreamCalls += 1; clock += 600; return Promise.resolve(mockFetchResponse(amapOk([poi("B1", "兰桂坊", 22.28, 114.15)]))); },
  });
  const first = await search("兰桂坊", "香港");
  assert.equal(first.places.length, 1);
  const second = await search("兰桂坊", "香港"); // 缓存命中：不 sleep、不请求
  assert.equal(second.places.length, 1);
  assert.equal(upstreamCalls, 1);
  const third = await search("兰桂坊", "香港");
  assert.equal(third.status, 200);
  assert.equal(upstreamCalls, 1, "cache TTL window still serving");
  // 5 分钟后缓存过期 → 又一次上游调用（走限流 sleep 推进时钟）
  clock += 5 * 60 * 1000 + 1;
  const fourth = await search("兰桂坊", "香港");
  assert.equal(fourth.places.length, 1);
  assert.equal(upstreamCalls, 2);
});

test("no key configured yields friendly 400 and never calls upstream", async () => {
  let called = false;
  const search = createAmapSearch({
    getKey: () => "",
    fetchImpl: async () => { called = true; return mockFetchResponse(amapOk([])); },
    sleep: async () => {},
  });
  const r = await search("中环", "香港");
  assert.equal(r.status, 400);
  assert.match(r.error!, /尚未配置/);
  assert.equal(called, false);
});

test("amap key settings persist across reopen and status reflects presence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-settings-"));
  const db = openTravelDB(dir, path.join(dir, "travel.db"));
  try {
    assert.equal(getAmapSettingsStatus(db).hasKey, false);
    assert.equal(getAmapKey(db), "");
    saveAmapKey(db, "ABCDEF0123456789ABCDEF0123456789");
    assert.equal(getAmapKey(db), "abcdef0123456789abcdef0123456789");
    assert.equal(getAmapSettingsStatus(db).hasKey, true);
    // v3 老库升级：模拟 v3（删表+降版本），重开迁移后默认空 Key
    db.exec("DROP TABLE travel_settings");
    db.pragma("user_version = 3");
    db.close();
    const reopened = openTravelDB(dir, path.join(dir, "travel.db"));
    assert.equal(Number(reopened.pragma("user_version", { simple: true })), 4);
    assert.equal(getAmapKey(reopened), "");
    // 格式校验
    assert.throws(() => saveAmapKey(reopened, "short"), /32 位十六进制/);
    assert.throws(() => saveAmapKey(reopened, "zzzz"), /32 位十六进制/);
    // 清除
    saveAmapKey(reopened, "");
    assert.equal(getAmapSettingsStatus(reopened).hasKey, false);
    reopened.close();
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
