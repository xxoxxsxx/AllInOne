import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Same vm-stub pattern as framelab-watermark.test.ts: evaluate the browser IIFE
// in an isolated context, no DOM and no build step.
const source = fs.readFileSync(new URL("../public/framelab/watermark-layers.js", import.meta.url), "utf8");
type Layer = {
  id: string; text: string; font: string; size: number; opacity: number;
  color: string; position: string; x: number; y: number;
};
type FrameLabWatermarkLayers = {
  normalizeLayer: (raw: unknown, fallbackId?: string) => Layer | null;
  normalizeLayers: (list: unknown) => Layer[];
  migrateLegacyLayer: (saved: unknown) => Layer | null;
};
const context = vm.createContext({ window: {} as { FrameLabWatermarkLayers?: FrameLabWatermarkLayers } });
vm.runInContext(source, context);
const layers = context.window.FrameLabWatermarkLayers;
assert.ok(layers, "watermark-layers.js must expose window.FrameLabWatermarkLayers");
const { normalizeLayer, normalizeLayers, migrateLegacyLayer } = layers;

// Results come from the vm realm, so their prototype differs from host objects
// and deepStrictEqual would reject structurally equal values. Copy before comparing.
const snapshot = (value: unknown) => value && typeof value === "object" ? {...value as object} : value;

const raw = (overrides: Partial<Layer> = {}) => ({
  id: "a", text: "RICOH", font: "sans", size: 45, opacity: 100,
  color: "#ffffff", position: "seam", x: 50, y: 50, ...overrides,
});

test("lists keep any number of layers with unique ids and per-layer styles", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ ...raw({ id: "same" }), text: `Mark ${i}`, size: 20 + i }));
  const list = normalizeLayers(many);
  assert.equal(list.length, 15, "no artificial count cap");
  assert.equal(new Set(list.map((layer: Layer) => layer.id)).size, 15, "ids must be unique");
  assert.equal(list[0].text, "Mark 0");
  assert.equal(list[14].text, "Mark 14");
  assert.equal(list[0].size, 20);
  assert.equal(list[14].size, 34);
  assert.equal(normalizeLayers(null).length, 0);
  assert.equal(normalizeLayers([null, 42, "junk"]).length, 0, "non-object entries are dropped");
  // Blank-text layers are valid state (cleared text stays editable after reload).
  assert.equal(normalizeLayers([null, 42, "junk", { text: "  " }]).length, 1);
  const collision = normalizeLayers([raw(), raw(), raw({ id: "b" }), raw({ id: "b" })]);
  assert.equal(new Set(collision.map((layer: Layer) => layer.id)).size, collision.length);
});

test("normalizeLayer clamps values and falls back to safe defaults", () => {
  const weird = normalizeLayer(raw({
    font: "comic-sans", size: 9999, opacity: -3, color: "red",
    position: "diagonal", x: -20, y: 140, text: "  ", id: "  ",
  }), "wm-9");
  assert.ok(weird);
  assert.equal(weird!.font, "sans");
  assert.equal(weird!.size, 180);
  assert.equal(weird!.opacity, 10);
  assert.equal(weird!.color, "#ffffff");
  assert.equal(weird!.position, "bottom-right");
  assert.equal(weird!.x, 0);
  assert.equal(weird!.y, 100);
  // Blank text is kept (an in-session layer may be cleared and retyped later).
  const blank = normalizeLayer(raw({ text: "  " }), "wm-1");
  assert.ok(blank);
  assert.equal(blank!.text, "  ");
});

test("legacy flat settings migrate into exactly one enabled layer", () => {
  const legacy = {
    "watermark-on": "true", "watermark-text": "RICOH", "watermark-font": "hand",
    "watermark-size": "45", "watermark-opacity": "100", "watermark-position": "custom",
    "text-color": "#123456", "watermark-x": "30.5", "watermark-y": "70.2",
  };
  assert.deepEqual(snapshot(migrateLegacyLayer(legacy)), {
    id: "wm-1", text: "RICOH", font: "hand", size: 45, opacity: 100,
    color: "#123456", position: "custom", x: 30.5, y: 70.2,
  });
  // Off, missing, or text-less setups must not invent a layer.
  assert.equal(migrateLegacyLayer({ ...legacy, "watermark-on": "false" }), null);
  assert.equal(migrateLegacyLayer({ ...legacy, "watermark-on": undefined }), null);
  assert.equal(migrateLegacyLayer({ ...legacy, "watermark-text": "   " }), null);
  assert.equal(migrateLegacyLayer(null), null);
  // An unknown position keeps the historical seam default, not the new-layer default.
  assert.equal(migrateLegacyLayer({ ...legacy, "watermark-position": "middle" })!.position, "seam");
});

test("persistence round-trips without mutating stored entries", () => {
  const list = normalizeLayers([raw(), raw({ id: "b", text: "第二", font: "serif", position: "bottom-right" })]);
  const restored = normalizeLayers(JSON.parse(JSON.stringify(list)));
  assert.deepEqual(restored.map(snapshot), list.map(snapshot));
});
