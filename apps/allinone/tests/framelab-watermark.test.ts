import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Same pattern as framelab-exif.test.ts: evaluate the browser IIFE in an isolated
// vm context, no DOM and no build step.
const source = fs.readFileSync(new URL("../public/framelab/watermark-geometry.js", import.meta.url), "utf8");
const context = vm.createContext({ window: {} as { FrameLabWatermarkGeometry?: FrameLabWatermarkGeometry } });
vm.runInContext(source, context);
const geometry = context.window.FrameLabWatermarkGeometry;
assert.ok(geometry, "watermark-geometry.js must expose window.FrameLabWatermarkGeometry");
const { computePlacement, moveToNormalized } = geometry;

type Placement = {
  x: number;
  y: number;
  width: number;
  ascent: number;
  descent: number;
  centerX: number;
  centerY: number;
};

type PlacementInput = {
  width: number;
  height: number;
  textWidth: number;
  ascent: number;
  descent: number;
  position: string;
  customX?: number;
  customY?: number;
  panelX?: number;
  panelY?: number;
  inset: number;
};

type FrameLabWatermarkGeometry = {
  computePlacement: (input: PlacementInput) => Placement;
  moveToNormalized: (point: { width: number; height: number; x: number; y: number }) => { x: number; y: number };
};

// Canonical canvas/font metrics: 1000x500 canvas, 50px margin, 300px text,
// ascent 40 / descent 10. All values are dyadic so expectations stay exact.
const BASE = { width: 1000, height: 500, textWidth: 300, ascent: 40, descent: 10, inset: 50 };
const GRID_POSITIONS = [
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
];
const ALL_POSITIONS = [...GRID_POSITIONS, "seam", "custom"];

function place(position: string, overrides: Partial<PlacementInput> = {}): Placement {
  return computePlacement({ ...BASE, position, ...overrides });
}

// Results come from the vm realm, so their prototype differs from host objects
// and deepStrictEqual would reject structurally equal values. Copy before comparing.
function snapshot<T extends object>(value: T): T {
  return { ...value };
}

// x/y are the Canvas left-baseline point for fillText: the glyph box spans
// [y - ascent, y + descent] vertically and [x, x + width] horizontally.
function assertTextBoxVisible(p: Placement, input: PlacementInput, label: string) {
  assert.ok(p.x >= 0 && p.x + p.width <= input.width, `${label}: glyph box must stay inside the canvas horizontally`);
  assert.ok(p.y - p.ascent >= 0 && p.y + p.descent <= input.height, `${label}: glyph box must stay inside the canvas vertically`);
}

test("nine grid presets reproduce the current drawWatermark position math", () => {
  // Expected values mirror app.js drawWatermark (inset margin, left-baseline fillText).
  const rows: Array<[string, Placement]> = [
    ["top-left", { x: 50, y: 90, width: 300, ascent: 40, descent: 10, centerX: 200, centerY: 75 }],
    ["top-center", { x: 350, y: 90, width: 300, ascent: 40, descent: 10, centerX: 500, centerY: 75 }],
    ["top-right", { x: 650, y: 90, width: 300, ascent: 40, descent: 10, centerX: 800, centerY: 75 }],
    ["center-left", { x: 50, y: 265, width: 300, ascent: 40, descent: 10, centerX: 200, centerY: 250 }],
    ["center", { x: 350, y: 265, width: 300, ascent: 40, descent: 10, centerX: 500, centerY: 250 }],
    ["center-right", { x: 650, y: 265, width: 300, ascent: 40, descent: 10, centerX: 800, centerY: 250 }],
    ["bottom-left", { x: 50, y: 440, width: 300, ascent: 40, descent: 10, centerX: 200, centerY: 425 }],
    ["bottom-center", { x: 350, y: 440, width: 300, ascent: 40, descent: 10, centerX: 500, centerY: 425 }],
    ["bottom-right", { x: 650, y: 440, width: 300, ascent: 40, descent: 10, centerX: 800, centerY: 425 }],
  ];
  for (const [position, expected] of rows) {
    assert.deepEqual(snapshot(place(position)), expected, position);
  }
  // Glyph box clears the margins on every preset (y is the baseline, not the top).
  for (const position of GRID_POSITIONS) {
    const p = place(position);
    assert.ok(p.x >= BASE.inset && p.x + p.width <= BASE.width - BASE.inset, `${position}: side margins respected`);
    assert.ok(p.y - p.ascent >= BASE.inset, `${position}: glyph top clears the top margin`);
    assert.ok(p.y + p.descent <= BASE.height - BASE.inset, `${position}: glyph bottom clears the bottom margin`);
  }
});

test("presets stay in sync with the legacy drawWatermark math across canvas sizes", () => {
  // Direct mirror of the current app.js math for the nine non-seam presets.
  function legacyPlacement(W: number, H: number, textWidth: number, ascent: number, descent: number, position: string, inset: number) {
    const width = Math.min(textWidth, W - 2 * inset);
    let x = inset;
    if (position.includes("right")) x = W - inset - width;
    else if (!position.includes("left")) x = (W - width) / 2;
    let y = H / 2 + (ascent - descent) / 2;
    if (position.startsWith("top")) y = inset + ascent;
    else if (position.startsWith("bottom")) y = H - inset - descent;
    return { x, y, width };
  }
  const canvases: Array<PlacementInput> = [
    { width: 1000, height: 500, textWidth: 300, ascent: 40, descent: 10, inset: 50, position: "" },
    { width: 1920, height: 1080, textWidth: 640, ascent: 96, descent: 24, inset: 53, position: "" },
    { width: 1080, height: 1920, textWidth: 480, ascent: 64, descent: 16, inset: 30, position: "" },
  ];
  for (const canvas of canvases) {
    for (const position of GRID_POSITIONS) {
      const p = computePlacement({ ...canvas, position });
      const legacy = legacyPlacement(canvas.width, canvas.height, canvas.textWidth, canvas.ascent, canvas.descent, position, canvas.inset);
      assert.deepEqual({ x: p.x, y: p.y, width: p.width }, legacy, `${position} @ ${canvas.width}x${canvas.height}`);
    }
  }
});

test("seam centers the text on the panel intersection with a canvas-center fallback", () => {
  const p = place("seam", { panelX: 600, panelY: 250 });
  assert.deepEqual(snapshot(p), { x: 450, y: 265, width: 300, ascent: 40, descent: 10, centerX: 600, centerY: 250 });

  // panels() yields 0/absent coordinates for single-photo layouts: fall back to
  // the canvas center. Only strictly positive panel coordinates are honored.
  for (const panel of [{}, { panelX: 0, panelY: 0 }, { panelX: -5, panelY: -1 }]) {
    const fallback = place("seam", panel);
    assert.deepEqual(
      snapshot(fallback),
      { x: 350, y: 265, width: 300, ascent: 40, descent: 10, centerX: 500, centerY: 250 },
      `panel ${JSON.stringify(panel)} falls back to canvas center`,
    );
  }
});

test("custom places the text bounding box center at normalized coordinates", () => {
  const p = place("custom", { customX: 0.3, customY: 0.7 });
  assert.deepEqual(snapshot(p), { x: 150, y: 365, width: 300, ascent: 40, descent: 10, centerX: 300, centerY: 350 });

  // The custom point is the glyph-box CENTER, decoupled from the baseline point.
  const quarter = place("custom", { customX: 0.25, customY: 0.75 });
  assert.equal(quarter.x + quarter.width / 2, 250);
  assert.equal(quarter.y - (quarter.ascent - quarter.descent) / 2, 375);

  // Missing or non-finite custom coordinates fall back to the canvas center,
  // i.e. custom behaves like the center preset.
  assert.deepEqual(place("custom"), place("center"));
  assert.deepEqual(place("custom", { customX: Number.NaN, customY: Number.NaN }), place("center"));
});

test("edge clamping keeps the text fully visible inside the canvas", () => {
  // Custom coordinates dragged to/past the corners converge on the grid presets.
  assert.deepEqual(place("custom", { customX: 0, customY: 0 }), place("top-left"));
  assert.deepEqual(place("custom", { customX: 1, customY: 1 }), place("bottom-right"));
  assert.deepEqual(place("custom", { customX: -3, customY: 9 }), place("bottom-left"));

  // A seam point hugging the edge is clamped back inside instead of being cropped.
  const seam = place("seam", { panelX: 10, panelY: 480 });
  assert.deepEqual(snapshot(seam), { x: 50, y: 440, width: 300, ascent: 40, descent: 10, centerX: 200, centerY: 425 });

  for (const position of ALL_POSITIONS) {
    const p = place(position, { panelX: 1, panelY: 499, customX: 0, customY: 1 });
    assertTextBoxVisible(p, { ...BASE, position }, position);
  }
});

test("text wider than the canvas is clamped to the available width", () => {
  // Available width = 1000 - 2 * 50 = 900; long text stays fully visible everywhere.
  for (const position of ALL_POSITIONS) {
    const p = place(position, { textWidth: 5000, panelX: 600, panelY: 250, customX: 0.3, customY: 0.7 });
    assert.equal(p.width, 900, `${position}: width clamped to available width`);
    assertTextBoxVisible(p, { ...BASE, textWidth: 5000, position }, position);
  }
  // With no slack left, every horizontal anchor lands on the same inset edge.
  assert.equal(place("center", { textWidth: 5000 }).x, 50);
  assert.equal(place("bottom-right", { textWidth: 5000 }).x, 50);
  assert.equal(place("seam", { textWidth: 5000, panelX: 600, panelY: 250 }).x, 50);
  // Empty text stays well-formed with zero width.
  assert.equal(place("center", { textWidth: 0 }).width, 0);
});

test("placements scale proportionally when canvas and metrics resize together", () => {
  const metrics = { width: 1000, height: 500, textWidth: 300, ascent: 40, descent: 10, inset: 50, panelX: 600, panelY: 250 };
  const custom = { customX: 0.3, customY: 0.7 };
  for (const k of [2, 0.5]) {
    for (const position of ALL_POSITIONS) {
      const base = computePlacement({ ...metrics, ...custom, position });
      const scaled = computePlacement({
        width: metrics.width * k,
        height: metrics.height * k,
        textWidth: metrics.textWidth * k,
        ascent: metrics.ascent * k,
        descent: metrics.descent * k,
        inset: metrics.inset * k,
        panelX: metrics.panelX * k,
        panelY: metrics.panelY * k,
        ...custom,
        position,
      });
      assert.deepEqual(
        snapshot(scaled),
        {
          x: base.x * k,
          y: base.y * k,
          width: base.width * k,
          ascent: base.ascent * k,
          descent: base.descent * k,
          centerX: base.centerX * k,
          centerY: base.centerY * k,
        },
        `${position} scaled by ${k}`,
      );
    }
  }
});

test("degenerate metrics stay well-formed", () => {
  // Negative font measurements are treated as zero.
  const flat = place("top-left", { ascent: -20, descent: -5 });
  assert.deepEqual(snapshot(flat), { x: 50, y: 50, width: 300, ascent: 0, descent: 0, centerX: 200, centerY: 50 });

  // An inset larger than half the canvas is capped at half the height; the text
  // then fills the whole height, so vertical placement degenerates to the middle.
  const capped = place("top-left", { inset: 600, textWidth: 600 });
  assert.deepEqual(snapshot(capped), { x: 250, y: 265, width: 500, ascent: 40, descent: 10, centerX: 500, centerY: 250 });

  // Text taller than the available height is vertically centered (it cannot be
  // fully visible), while horizontal placement still applies.
  const tall = place("bottom-center", { height: 100, textWidth: 200, ascent: 80, descent: 40, inset: 10 });
  assert.deepEqual(snapshot(tall), { x: 400, y: 70, width: 200, ascent: 80, descent: 40, centerX: 500, centerY: 50 });
});

test("moveToNormalized returns clamped normalized canvas coordinates", () => {
  assert.deepEqual(snapshot(moveToNormalized({ width: 800, height: 400, x: 400, y: 100 })), { x: 0.5, y: 0.25 });
  assert.deepEqual(snapshot(moveToNormalized({ width: 800, height: 400, x: -50, y: 900 })), { x: 0, y: 1 });
  assert.deepEqual(snapshot(moveToNormalized({ width: 800, height: 400, x: 1000, y: -1 })), { x: 1, y: 0 });
  // A zero-sized canvas has nothing to normalize against: fall back to the center.
  assert.deepEqual(snapshot(moveToNormalized({ width: 0, height: 0, x: 123, y: -9 })), { x: 0.5, y: 0.5 });

  // Round-trip with computePlacement: an unclamped custom center normalizes
  // back to the requested custom coordinates.
  const p = place("custom", { customX: 0.25, customY: 0.75 });
  assert.deepEqual(snapshot(moveToNormalized({ width: 1000, height: 500, x: p.centerX, y: p.centerY })), { x: 0.25, y: 0.75 });
});
