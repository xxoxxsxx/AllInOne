import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addPlace,
  createTrip,
  deletePlace,
  getTrip,
  openTravelDB,
  setRouteColor,
  type Place,
} from "../src/lib/travel/db.ts";
import { adjacentRoutePairs, arrowGeometry, routeColor } from "../src/lib/travel/routes.ts";
import { layoutTrip } from "../src/lib/travel/export-image.ts";

const place = (id: number, over: Partial<Place> = {}): Place => ({
  id, tripId: 1, dayId: null, name: `P${id}`, lat: null, lng: null,
  address: "", timeLabel: "", cost: "", note: "", links: [], photos: [], ...over,
});

test("route color validation, ownership, reset, reopen persistence and cascade", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-test-"));
  const db = openTravelDB(dir, path.join(dir, "travel.db"));
  try {
    const tripId = createTrip(db, { title: "颜色行程" });
    const dayId = getTrip(db, tripId)!.days[0].id;
    const a = addPlace(db, tripId, dayId, "A");
    const b = addPlace(db, tripId, dayId, "B");
    const otherTrip = createTrip(db, { title: "其他行程" });

    setRouteColor(db, tripId, a, b, "#FF00AA");
    let trip = getTrip(db, tripId)!;
    assert.deepEqual(trip.routeStyles, [{ fromPlaceId: a, toPlaceId: b, color: "#ff00aa" }]);

    // 严格 #RRGGBB；大小写归一
    assert.throws(() => setRouteColor(db, tripId, a, b, "ff00aa"), /#RRGGBB/);
    assert.throws(() => setRouteColor(db, tripId, a, b, "#ff00aab"), /#RRGGBB/);
    assert.throws(() => setRouteColor(db, tripId, a, b, "#ff00zz"), /#RRGGBB/);
    assert.throws(() => setRouteColor(db, tripId, a, a, "#ff00aa"), /同一个/);
    assert.throws(() => setRouteColor(db, otherTrip, a, b, "#ff00aa"), /不属于/);
    // 非法颜色不写入
    assert.equal(getTrip(db, tripId)!.routeStyles[0].color, "#ff00aa");

    // 重开库仍在（持久化）
    db.close();
    const reopened = openTravelDB(dir, path.join(dir, "travel.db"));
    assert.equal(getTrip(reopened, tripId)!.routeStyles[0].color, "#ff00aa");

    // 重置（空串）→ 移除样式
    setRouteColor(reopened, tripId, a, b, "");
    assert.deepEqual(getTrip(reopened, tripId)!.routeStyles, []);

    // 删地点级联清理样式
    setRouteColor(reopened, tripId, a, b, "#00ff00");
    deletePlace(reopened, a);
    assert.deepEqual(getTrip(reopened, tripId)!.routeStyles, []);
    reopened.close();
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("v2 database keeps transports and upgrades to v3 with route_styles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-v2-"));
  const db = openTravelDB(dir, path.join(dir, "travel.db"));
  try {
    const tripId = createTrip(db, { title: "升级行程" });
    const dayId = getTrip(db, tripId)!.days[0].id;
    const a = addPlace(db, tripId, dayId, "A");
    const b = addPlace(db, tripId, dayId, "B");
    // 模拟 v2：降版本号并删掉 v3 表
    db.exec("DROP TABLE route_styles");
    db.pragma("user_version = 2");
    db.close();
    const reopened = openTravelDB(dir, path.join(dir, "travel.db"));
    const trip = getTrip(reopened, tripId)!;
    assert.equal(Number(reopened.pragma("user_version", { simple: true })), 4);
    assert.equal(trip.days[0].places.length, 2, "places preserved");
    assert.deepEqual(trip.routeStyles, []);
    reopened.close();
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("adjacentRoutePairs: same-day neighbors only, unlocated stops break the chain", () => {
  const trip = {
    id: 1, title: "t", description: "", startDate: "", updatedAt: "",
    days: [
      { id: 1, title: "D1", places: [
        place(1, { dayId: 1, lat: 31.1, lng: 121.1 }),
        place(2, { dayId: 1, lat: 31.2, lng: 121.2 }),
        place(3, { dayId: 1 }), // 未定位 → 2-3、3-4 都不连
        place(4, { dayId: 1, lat: 31.4, lng: 121.4 }),
      ] },
      { id: 2, title: "D2", places: [place(5, { dayId: 2, lat: 31.5, lng: 121.5 })] },
    ],
    loose: [place(6, { lat: 31.6, lng: 121.6 })],
    transports: [], routeStyles: [],
  } as unknown as Parameters<typeof adjacentRoutePairs>[0];
  const pairs = adjacentRoutePairs(trip);
  assert.deepEqual(pairs.map(p => [p.from.id, p.to.id]), [[1, 2]]);
  assert.equal(pairs[0].dayIndex, 0);
});

test("arrowGeometry: orientation, 62% tip, rejects short/coincident/non-finite", () => {
  const east = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
  assert.ok(east);
  const [wA, tip, wB] = east;
  assert.equal(tip.x, 62); assert.equal(tip.y, 0);
  assert.ok(Math.abs(wA.x - 52) < 1e-9);
  assert.ok(Math.abs(wA.y - 6) < 1e-9); // canvas y 向下：东向时两翼在 tip 后方 ±6
  assert.ok(Math.abs(wB.y + 6) < 1e-9);
  assert.ok(Math.abs(wB.x - 52) < 1e-9);
  const south = arrowGeometry({ x: 0, y: 0 }, { x: 0, y: 100 }, 10)!;
  assert.equal(south[1].y, 62);
  const west = arrowGeometry({ x: 100, y: 0 }, { x: 0, y: 0 }, 10)!;
  assert.equal(west[1].x, 38);
  const north = arrowGeometry({ x: 0, y: 100 }, { x: 0, y: 0 }, 10)!;
  assert.equal(north[1].y, 38);
  assert.equal(arrowGeometry({ x: 0, y: 0 }, { x: 5, y: 0 }, 10), null); // 太短
  assert.equal(arrowGeometry({ x: 0, y: 0 }, { x: 0, y: 0 }, 10), null); // 同点
  assert.equal(arrowGeometry({ x: 0, y: 0 }, { x: NaN, y: 100 }, 10), null);
  assert.equal(arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 0), null);
});

test("export map edges follow real adjacency with custom colors; no cross-day or skipped chains", () => {
  const trip = {
    id: 1, title: "边导出", description: "", startDate: "", updatedAt: "",
    transports: [], routeStyles: [{ fromPlaceId: 1, toPlaceId: 2, color: "#123456" }],
    days: [
      { id: 1, title: "D1", places: [
        place(1, { dayId: 1, lat: 31.1, lng: 121.1 }),
        place(2, { dayId: 1, lat: 31.2, lng: 121.2 }),
        place(3, { dayId: 1 }), // 未定位：2→3 不连、3→4 不连
        place(4, { dayId: 1, lat: 31.4, lng: 121.4 }),
      ] },
      { id: 2, title: "D2", places: [place(5, { dayId: 2, lat: 31.5, lng: 121.5 })] },
    ],
    loose: [],
  } as unknown as Parameters<typeof layoutTrip>[0];
  const pages = layoutTrip(trip, () => 10);
  const map = pages.flatMap(p => p.blocks).find(b => b.kind === "map");
  assert.ok(map && map.kind === "map");
  assert.deepEqual(map.edges, [{ fromIndex: 0, toIndex: 1, color: "#123456" }]);
});
