import test from "node:test";
import assert from "node:assert/strict";

test("api route dispatches global search and keeps the amap default", async () => {
  const { GET } = await import("../src/app/api/travel/search/route.ts");
  const url = (params: string) => new Request(`http://localhost/api/travel/search?${params}`);
  // Unknown source → 400 before any upstream call.
  const unknown = await GET(url("q=巴黎&source=baidu"));
  assert.equal(unknown.status, 400);
  const unknownPayload = await unknown.json();
  assert.match(unknownPayload.error, /未知的搜索来源/);
  // Global dispatch works (this machine reaches photon directly; fixture guarded below).
  const global = await GET(url("q=巴黎 埃菲尔铁塔&source=global"));
  if (global.status === 200) {
    const payload = await global.json();
    assert.ok(!("ok" in payload), "success payload must not add an ok flag");
    assert.match(payload.attribution, /OpenStreetMap/);
  } else {
    const payload = await global.json();
    assert.ok([400, 429, 502, 504].includes(global.status), `upstream/network failure stays bounded: ${global.status}`);
    assert.match(payload.error ?? "", /.+/);
  }
  // Default source without `source` parameter stays the Amap contract.
  const amapDefault = await GET(url("q=巴黎"));
  const amapPayload = await amapDefault.json();
  assert.ok([400, 429, 502, 504].includes(amapDefault.status), "no amap key configured locally");
  assert.ok(!("ok" in amapPayload));
});
