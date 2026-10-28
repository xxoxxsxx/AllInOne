// 坐标转换纯函数测试：往返一致性、偏移量级、境外恒等、底图↔存储互逆。

import test from "node:test";
import assert from "node:assert/strict";

import {
  gcj02ToWgs84,
  isInChina,
  storageToTile,
  tileToStorage,
  wgs84ToGcj02,
  type LatLng,
} from "../src/lib/travel/coordinates.ts";

function offset(a: LatLng, b: LatLng): { dLat: number; dLng: number } {
  return { dLat: Math.abs(a.lat - b.lat), dLng: Math.abs(a.lng - b.lng) };
}

test("境外坐标两种变换均为恒等", () => {
  const outside: LatLng[] = [
    { lat: 48.8566, lng: 2.3522 }, // 巴黎
    { lat: 40.7128, lng: -74.006 }, // 纽约
    { lat: -33.8688, lng: 151.2093 }, // 悉尼
    { lat: 40, lng: 60 }, // 中亚（范围外）
  ];
  for (const p of outside) {
    assert.deepEqual(wgs84ToGcj02(p), p, `wgs->gcj should identity: ${p.lat},${p.lng}`);
    assert.deepEqual(gcj02ToWgs84(p), p, `gcj->wgs should identity: ${p.lat},${p.lng}`);
  }
  assert.equal(isInChina({ lat: 48.8566, lng: 2.3522 }), false);
});

test("国内已知量级：北京附近 GCJ 相对 WGS 偏移数百米且往返闭合", () => {
  const wgs: LatLng = { lat: 39.9075, lng: 116.3912 }; // 北京市中心附近
  const gcj = wgs84ToGcj02(wgs);
  const d = offset(wgs, gcj);
  // GCJ 偏移通常几百米（约 0.002°–0.008°）； catches 明显的实现错误（如写反/放大）
  assert.ok(d.dLng > 0.001 && d.dLng < 0.012, `lng offset ${d.dLng}`);
  assert.ok(d.dLat > 0.001 && d.dLat < 0.012, `lat offset ${d.dLat}`);
  const back = gcj02ToWgs84(gcj);
  const r = offset(wgs, back);
  assert.ok(r.dLat < 1e-5 && r.dLng < 1e-5, `roundtrip drift ${r.dLat},${r.dLng}`);
});

test("国内多点往返闭合（上海/成都/哈尔滨/海口）且确定性", () => {
  const points: LatLng[] = [
    { lat: 31.2304, lng: 121.4737 }, // 上海
    { lat: 30.5728, lng: 104.0668 }, // 成都
    { lat: 45.8038, lng: 126.535 }, // 哈尔滨
    { lat: 20.0444, lng: 110.1999 }, // 海口
    { lat: 43.8171, lng: 87.6014 }, // 乌鲁木齐
  ];
  for (const p of points) {
    const g1 = wgs84ToGcj02(p);
    const g2 = wgs84ToGcj02(p);
    assert.deepEqual(g1, g2, "deterministic");
    const back = gcj02ToWgs84(g1);
    const d = offset(p, back);
    assert.ok(d.dLat < 1e-5 && d.dLng < 1e-5, `roundtrip ${p.lat},${p.lng}: ${d.dLat},${d.dLng}`);
  }
});

test("底图↔存储互逆：osm 走 wgs，amap 恒等", () => {
  const stored: LatLng = { lat: 31.2304, lng: 121.4737 }; // 存储 = GCJ
  const osmView = storageToTile("osm", stored);
  const d = offset(stored, osmView);
  assert.ok(d.dLat > 0.0005 && d.dLng > 0.0005, "osm view should shift");
  const round = tileToStorage("osm", osmView);
  const rd = offset(stored, round);
  assert.ok(rd.dLat < 1e-5 && rd.dLng < 1e-5, "osm roundtrip");
  // amap：存储即渲染，渲染即存储
  assert.deepEqual(storageToTile("amap", stored), stored);
  assert.deepEqual(tileToStorage("amap", stored), stored);
});

test("范围边界附近不抛错且境外侧恒等", () => {
  const edge: LatLng[] = [
    { lat: 0.8293, lng: 72.004 }, // 恰在界上（含）
    { lat: 55.8271, lng: 137.8347 },
    { lat: 0.8, lng: 110 }, // 界外（南侧海域）
    { lat: 30, lng: 138 }, // 界外（东侧）
  ];
  for (const p of edge) {
    assert.doesNotThrow(() => wgs84ToGcj02(p));
    assert.doesNotThrow(() => gcj02ToWgs84(p));
  }
  assert.deepEqual(wgs84ToGcj02({ lat: 0.8, lng: 110 }), { lat: 0.8, lng: 110 });
});
