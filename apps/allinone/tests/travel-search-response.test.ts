import test from "node:test";
import assert from "node:assert/strict";
import { readSearchResponse } from "../src/lib/travel/search-response.ts";
import { createAmapSearch } from "../src/lib/travel/search.ts";

const place = { id: "B0001", name: "太平山顶", address: "山顶道", lat: 22.2695, lng: 114.1502 };

test("browser accepts the actual HTTP 200 search payload without a JSON ok flag", async () => {
  const search = createAmapSearch({
    getKey: () => "a".repeat(32), sleep: async () => {},
    fetchImpl: async () => Response.json({ status: "1", pois: [{
      id: place.id, name: place.name, address: place.address, location: `${place.lng},${place.lat}`,
    }] }),
  });
  const result = await search("接口契约回归", "香港");
  assert.equal(result.status, 200);
  // Same envelope and JSON serialization as /api/travel/search GET.
  const response = Response.json({ places: result.places, attribution: result.attribution }, { status: result.status });
  const data = await response.json();
  assert.equal("ok" in data, false);
  assert.deepEqual(readSearchResponse(response.ok, data).places, [place]);
});

test("empty success results and server error responses follow HTTP status", () => {
  assert.deepEqual(readSearchResponse(true, { places: [], attribution: "高德地图" }).places, []);
  assert.throws(() => readSearchResponse(false, { error: "高德 Key 无效或未开通搜索权限" }), /Key 无效/);
  assert.throws(() => readSearchResponse(false, null), /搜索失败/);
});

test("malformed successful payloads are rejected before rendering or adding places", () => {
  for (const value of [null, {}, { places: {} }, { places: [place] },
    { places: [{ ...place, lat: NaN }], attribution: "高德地图" },
    { places: [{ ...place, lng: 181 }], attribution: "高德地图" },
    { places: [{ ...place, name: 3 }], attribution: "高德地图" },
  ]) assert.throws(() => readSearchResponse(true, value), /无效的地点数据/);
});
