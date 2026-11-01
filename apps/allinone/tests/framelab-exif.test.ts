import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Evaluate the actual browser helpers in an isolated context, without a DOM or build step.
const source = fs.readFileSync(new URL("../public/framelab/exif-format.js", import.meta.url), "utf8");
const context = vm.createContext({ window: {} as { FrameLabExifFormat?: Helpers } });
vm.runInContext(source, context);
type ExifFields = { aperture: string; shutter: string; iso: string; focal: string };
type Helpers = {
  formatAperture: (value: unknown) => string;
  formatShutter: (value: unknown) => string;
  formatFocal: (focal35: unknown, focal: unknown) => string;
  buildExifFields: (exif: Record<string, unknown> | null) => ExifFields;
  buildExifCaption: (fields: ExifFields, selected: string[]) => string;
};
const helpers = context.window.FrameLabExifFormat;
assert.ok(helpers);
const { formatAperture, formatShutter, formatFocal, buildExifFields, buildExifCaption } = helpers;

test("aperture uses one decimal only when needed", () => {
  assert.equal(formatAperture(2.8), "f/2.8");
  assert.equal(formatAperture(8), "f/8");
  assert.equal(formatAperture(0.95), "f/0.95");
  assert.equal(formatAperture(undefined), "");
  assert.equal(formatAperture(-1), "");
});

test("shutter formats whole seconds, rounded seconds and fractions", () => {
  assert.equal(formatShutter(2), "2s");
  assert.equal(formatShutter(1.26), "1.3s");
  assert.equal(formatShutter(0.004), "1/250s");
  assert.equal(formatShutter(0.0081), "1/123s");
  // 0.5–1s 的慢门用小数秒，避免 1/Math.round(1/v) 舍入成错误的 1/1s。
  assert.equal(formatShutter(0.8), "0.8s");
  assert.equal(formatShutter(0.6), "0.6s");
  assert.equal(formatShutter(0.5), "1/2s");
  assert.equal(formatShutter(0), "");
});

test("focal length rounds and prefers 35mm equivalent with fallback", () => {
  assert.equal(formatFocal(27.7, 18.3), "28mm");
  assert.equal(formatFocal(undefined, 18.6), "19mm");
  assert.equal(formatFocal(0, undefined), "");
  assert.equal(buildExifFields({ FocalLengthIn35mmFormat: 28, FocalLengthIn35mmFilm: 35, FocalLength: 18 }).focal, "28mm");
  assert.equal(buildExifFields({ FocalLengthIn35mmFilm: 35, FocalLength: 18 }).focal, "35mm");
  assert.equal(buildExifFields({ FocalLength: 18 }).focal, "18mm");
});

test("caption uses selected fields in display order and skips missing fields", () => {
  const fields = buildExifFields({ FNumber: 2.8, ExposureTime: 0.004, ISO: 400 });
  assert.equal(buildExifCaption(fields, ["focal", "iso", "aperture", "shutter"]), "f/2.8 1/250s ISO 400");
  assert.equal(buildExifCaption(fields, ["shutter", "focal"]), "1/250s");
  assert.equal(buildExifCaption(fields, []), "");
  assert.equal(buildExifCaption(buildExifFields(null), ["aperture", "shutter", "iso", "focal"]), "");
});
