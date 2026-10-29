import test from "node:test";
import assert from "node:assert/strict";
import { BASEMAPS } from "../src/lib/travel/basemaps.ts";
import { storageToTile, tileToStorage } from "../src/lib/travel/coordinates.ts";

test("global street map uses its provider z/y/x order and WGS coordinates", () => {
  assert.match(BASEMAPS.esri.url, /\/tile\/\{z\}\/\{y\}\/\{x\}$/);
  assert.match(BASEMAPS.esri.attribution, /Esri/);
  const stored = { lat: 31.23, lng: 121.47 };
  assert.deepEqual(storageToTile("esri", stored), storageToTile("osm", stored));
  const back = tileToStorage("esri", storageToTile("esri", stored));
  assert.ok(Math.abs(back.lat - stored.lat) < 1e-5);
  assert.ok(Math.abs(back.lng - stored.lng) < 1e-5);
  const paris = { lat: 48.8566, lng: 2.3522 };
  assert.deepEqual(storageToTile("esri", paris), paris);
});
