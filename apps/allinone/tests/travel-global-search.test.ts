import test from "node:test";
import assert from "node:assert/strict";
import { createGlobalSearch, parsePhotonPlaces } from "../src/lib/travel/global-search.ts";

const feature = (name: string, lat: number, lng: number, osmType = "N", osmId = 1, extra: Record<string, unknown> = {}) => ({
  type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] },
  properties: { osm_type: osmType, osm_id: osmId, name, ...extra },
});

test("global search returns cleaned GCJ coordinates, attribution and dedupes ids", async () => {
  await new Promise(r => setTimeout(r, 1100)); // leave the shared 1s slot for this instance
  let calls = 0;
  const search = createGlobalSearch({
    now: () => 1_000_000,
    fetchImpl: async () => { calls += 1; return Response.json({
      features: [
        feature("Tour Eiffel", 48.858260, 2.294501),
        feature("Dup", 48.85, 2.29, "N", 5),
        feature("Dup", 48.85, 2.29, "N", 5),
        feature("NoName", 48.85, 2.29, "N", 2),
        feature("BadGeo", 48.85, 2.29, "N", 3, {}),
      ],
    }); },
  });
  const result = await search("Eiffel Tower", "Paris");
  assert.equal(result.status, 200);
  assert.equal(result.places.length, 4);
  assert.equal(result.places[0].id, "N1");
  assert.equal(result.places[0].name, "Tour Eiffel");
  assert.deepEqual(result.places[0], { id: "N1", name: "Tour Eiffel", address: "", lat: 48.858260, lng: 2.294501 });
  assert.deepEqual(result.places[1], { id: "N5", name: "Dup", address: "", lat: 48.85, lng: 2.29 });
  assert.equal(result.places[2].id, "N2");
  assert.equal(result.places[3].id, "N3");
  assert.match(result.attribution, /OpenStreetMap/);
  assert.equal(calls, 1);
});

test("results convert domestic WGS coordinates into project GCJ storage", async () => {
  const search = createGlobalSearch({ now: () => 1_000_000,
    fetchImpl: async () => Response.json({ features: [feature("北京地点", 39.9075, 116.3912, "N", 7)] }) });
  const r = await search("北京地点", "");
  // WGS 39.9075,116.3912 is ~600m from stored GCJ: the parser must convert.
  assert.ok(Math.abs(r.places[0].lat - 39.9075) > 0.001);
  assert.ok(Math.abs(r.places[0].lng - 116.3912) > 0.001);
});

test("upstream errors, timeout, rate limiting and cache are handled", async () => {
  let clock = 1_000_000, calls = 0;
  const search = createGlobalSearch({
    now: () => clock, timeoutMs: 5,
    fetchImpl: (_input, init) => new Promise((_r, reject) => {
      calls += 1;
      const onAbort = () => reject(Object.assign(new Error("abort"), { name: "AbortError" }));
      init?.signal?.addEventListener("abort", onAbort, { once: true });
      setTimeout(() => reject(new Error("late")), 5);
    }),
  });
  const timeout = await search("Eiffel Tower", "");
  assert.equal(timeout.status, 504);
  assert.match(timeout.error!, /超时/);
  const failing = createGlobalSearch({ now: () => 1_000_000,
    fetchImpl: async () => new Response("boom", { status: 500 }) });
  const bad = await failing("Eiffel Tower", "");
  assert.equal(bad.status, 502);
  assert.match(bad.error!, /暂时不可用/);
  clock = 1_000_000; // reset the clock after the timeout test
  // Rate limit: second immediate request is rejected without an upstream call.
  const limited = createGlobalSearch({ now: () => Date.now(),
    fetchImpl: async () => { calls += 1; return Response.json({ features: [feature("第一次", 1, 1)] }); } });
  assert.equal((await limited("Eiffel Tower", "")).status, 200);
  assert.equal((await limited("Different Place", "")).status, 429);
  assert.equal(calls, 2, "rate-limited request must not reach upstream");
  // Cache TTL expired and interval passed: upstream is called again.
  await new Promise(r => setTimeout(r, 1100));
  const cached = await limited("Eiffel Tower", "");
  assert.equal(cached.status, 200);
  assert.equal(calls, 2);
});

test("malformed payloads and invalid inputs return friendly errors", async () => {
  const search = createGlobalSearch({
    fetchImpl: async () => Response.json({ features: [{ type: "Feature", geometry: { type: "Point", coordinates: [200, 999] }, properties: { osm_type: "N", osm_id: 9, name: "坏" } }] }) });
  const r = await search("Eiffel Tower", "");
  assert.equal(r.status, 200, "valid features with out-of-range coordinates are dropped, not failed");
  assert.equal(r.places.length, 0);

  assert.equal((await search("E", "")).status, 400);
  assert.equal((await search("ok", "x".repeat(41))).status, 400);
});
