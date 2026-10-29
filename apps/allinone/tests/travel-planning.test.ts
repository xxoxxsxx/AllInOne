import test from "node:test";
import assert from "node:assert/strict";
import { dayDateLabel, parsePlaceLines, MAX_BATCH_TEXT_LENGTH } from "../src/lib/travel/planning.ts";
import { openTravelDB, createTrip, getTrip, addPlace, batchAddPlaces } from "../src/lib/travel/db.ts";

test("day labels handle month-end, leap day and New Year with explicit years", () => {
  assert.equal(dayDateLabel("2026-01-31", 1), "2026年2月1日 · 星期日");
  assert.equal(dayDateLabel("2024-02-28", 1), "2024年2月29日 · 星期四");
  assert.equal(dayDateLabel("2024-02-28", 2), "2024年3月1日 · 星期五");
  assert.equal(dayDateLabel("2026-12-31", 1), "2027年1月1日 · 星期五");
  assert.equal(dayDateLabel("0099-12-31", 1), "0100年1月1日 · 星期五");
});

test("date-only validation never silently normalizes invalid dates or offsets", () => {
  for (const date of ["", " ", "2026-02-29", "2024-02-30", "2026-13-01", "2026-00-01", "2026-1-01", "2026-01-01T00:00:00Z", "2026-01-01+08:00"]) {
    assert.equal(dayDateLabel(date, 0), "", date);
  }
  for (const index of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.equal(dayDateLabel("2026-01-01", index), "");
  assert.equal(dayDateLabel("9999-12-31", 1), "");
});

test("labels are timezone and DST independent", () => {
  const old = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Shanghai", "America/New_York", "Pacific/Honolulu", "Europe/Berlin"]) {
      process.env.TZ = tz;
      assert.equal(dayDateLabel("2026-03-07", 2), "2026年3月9日 · 星期一", tz);
      assert.equal(dayDateLabel("2026-10-31", 2), "2026年11月2日 · 星期一", tz);
    }
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

test("line parser trims, ignores blanks and preserves duplicates and order", () => {
  assert.deepEqual(parsePlaceLines("  中环  \r\n\n 太平山顶 \r 中环\n\t\n"), ["中环", "太平山顶", "中环"]);
  assert.deepEqual(parsePlaceLines(" \n \r\n"), []);
  assert.equal(parsePlaceLines(Array(50).fill("中环").join("\n")).length, 50);
  assert.throws(() => parsePlaceLines(Array(51).fill("中环").join("\n")), /50/);
  assert.throws(() => parsePlaceLines("x".repeat(81)), /80/);
  assert.throws(() => parsePlaceLines(" ".repeat(MAX_BATCH_TEXT_LENGTH + 1)), /文本/);
  assert.throws(() => parsePlaceLines("中\u0000环"), /控制/);
});

test("batch append validates ownership and all names before writing", () => {
  const db = openTravelDB();
  try {
    const tripId = createTrip(db, { title: "香港" });
    const dayId = getTrip(db, tripId)!.days[0].id;
    const otherTrip = createTrip(db, { title: "其他行程" });
    const otherDay = getTrip(db, otherTrip)!.days[0].id;
    addPlace(db, tripId, dayId, "已有地点");
    assert.throws(() => batchAddPlaces(db, tripId, otherDay, "中环"), /不属于/);
    assert.throws(() => batchAddPlaces(db, 9999, null, "中环"), /不存在/);
    assert.throws(() => batchAddPlaces(db, tripId, dayId, "中环\n" + "x".repeat(81)), /80/);
    assert.throws(() => batchAddPlaces(db, tripId, dayId, Array(51).fill("a").join("\n")), /50/);
    assert.throws(() => batchAddPlaces(db, tripId, dayId, " \n "), /至少/);
    assert.deepEqual(getTrip(db, tripId)!.days[0].places.map((p) => p.name), ["已有地点"]);
    const ids = batchAddPlaces(db, tripId, dayId, " 中环\r\n\n太平山顶\n中环 ");
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(getTrip(db, tripId)!.days[0].places.map((p) => p.name), ["已有地点", "中环", "太平山顶", "中环"]);
    assert.equal(batchAddPlaces(db, tripId, dayId, Array(50).fill("合法重复").join("\n")).length, 50);
    assert.equal(getTrip(db, otherTrip)!.days[0].places.length, 0);
  } finally { db.close(); }
});

test("database failure mid-batch rolls back names and timestamp together", () => {
  const db = openTravelDB();
  try {
    const tripId = createTrip(db, { title: "回滚" });
    const dayId = getTrip(db, tripId)!.days[0].id;
    db.prepare("UPDATE trips SET updated_at='before' WHERE id=?").run(tripId);
    db.exec("CREATE TRIGGER reject_place BEFORE INSERT ON places WHEN NEW.name='失败' BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => batchAddPlaces(db, tripId, dayId, "第一站\n失败\n最后一站"), /injected/);
    const trip = getTrip(db, tripId)!;
    assert.equal(trip.days[0].places.length, 0);
    assert.equal(trip.updatedAt, "before");
  } finally { db.close(); }
});
