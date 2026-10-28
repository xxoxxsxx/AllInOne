// 旅行攻略模块测试：schema/CRUD/排序/级联删除、平台识别、照片文件校验。
// 运行：pnpm test（node --test + alias-loader）

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addDay,
  addLink,
  addPhotoRow,
  addPlace,
  createTrip,
  deleteDay,
  deletePhoto,
  deletePlace,
  deleteTrip,
  getTrip,
  listTripSummaries,
  moveDay,
  movePlace,
  normalizeUrl,
  openTravelDB,
  renameDay,
  reorderPlaces,
  updatePlace,
  updateTrip,
} from "../src/lib/travel/db.ts";
import { detectPlatform, platformById } from "../src/lib/travel/platforms.ts";
import {
  contentTypeOf,
  extFromMime,
  isValidPhotoFilename,
  readPhotoFile,
  removePhotoFile,
  savePhotoFile,
} from "../src/lib/travel/photos.ts";

test("createTrip seeds Day 1 and full CRUD/reorder/move works", () => {
  const db = openTravelDB();
  try {
    const tripId = createTrip(db, { title: "大理 5 日", description: "环洱海", startDate: "2026-11-01" });
    const trip = getTrip(db, tripId);
    assert.ok(trip);
    assert.equal(trip!.days.length, 1);
    assert.equal(trip!.days[0].title, "Day 1");

    const day2 = addDay(db, tripId, "第二天·环海西路");
    const day1Id = trip!.days[0].id;
    const p1 = addPlace(db, tripId, day1Id, "才村码头");
    const p2 = addPlace(db, tripId, day1Id, "喜洲古镇");
    const p3 = addPlace(db, tripId, day2, "海舌公园");

    // 天内排序：追加顺序即游览顺序
    let t = getTrip(db, tripId)!;
    assert.deepEqual(t.days[0].places.map((p) => p.id), [p1, p2]);

    reorderPlaces(db, day1Id, [p2, p1]);
    t = getTrip(db, tripId)!;
    assert.deepEqual(t.days[0].places.map((p) => p.id), [p2, p1]);

    // 移动到另一天 → 追加到末尾
    movePlace(db, p2, day2);
    t = getTrip(db, tripId)!;
    assert.deepEqual(t.days[0].places.map((p) => p.id), [p1]);
    assert.deepEqual(t.days[1].places.map((p) => p.id), [p3, p2]);

    // 非法排序（不是全排列）应拒绝
    assert.throws(() => reorderPlaces(db, day2, [p3]));
    assert.throws(() => reorderPlaces(db, day2, [p3, p3]));

    updatePlace(db, p1, { name: "才村码头", lat: 25.705, lng: 100.165, timeLabel: "上午", cost: "0", note: "看日出" });
    t = getTrip(db, tripId)!;
    assert.equal(t.days[0].places[0].lat, 25.705);
    // 经纬度必须成对：无坐标地点只给 lat（或清掉一半）都应拒绝
    const p4 = addPlace(db, tripId, day1Id, "未标注地点");
    assert.throws(() => updatePlace(db, p4, { lat: 30 }));
    assert.throws(() => updatePlace(db, p1, { lng: null }));

    // 天操作：重命名、上移、删除（地点进待安排）
    renameDay(db, day2, "Day 2 环海");
    moveDay(db, day2, -1);
    t = getTrip(db, tripId)!;
    assert.equal(t.days[0].title, "Day 2 环海");
    deleteDay(db, day2);
    t = getTrip(db, tripId)!;
    assert.equal(t.days.length, 1);
    assert.equal(t.loose.length, 2);
    assert.deepEqual(t.loose.map((p) => p.id).sort(), [p2, p3].sort());

    // 行程编辑与删除
    updateTrip(db, tripId, { title: "大理环海", startDate: "2026-11-02" });
    assert.equal(getTrip(db, tripId)!.title, "大理环海");
    deletePlace(db, p2);
    deleteTrip(db, tripId);
    assert.equal(getTrip(db, tripId), null);
  } finally {
    db.close();
  }
});

test("links detect platform and cascade with place; photos cascade and file lifecycle", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-test-"));
  const prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const db = openTravelDB(dir, path.join(dir, "travel.db"));
  try {
    const tripId = createTrip(db, { title: "测试行程" });
    const dayId = getTrip(db, tripId)!.days[0].id;
    const p = addPlace(db, tripId, dayId, "人民路小店");

    const l1 = addLink(db, p, "https://www.xiaohongshu.com/explore/abc", "探店笔记");
    addLink(db, p, "v.douyin.com/xxxx/"); // 无协议自动补 https
    addLink(db, p, "b23.tv/xyz");
    let t = getTrip(db, tripId)!;
    assert.deepEqual(t.days[0].places[0].links.map((l) => l.platform), ["xiaohongshu", "douyin", "bilibili"]);
    assert.equal(t.days[0].places[0].links[0].url, "https://www.xiaohongshu.com/explore/abc");

    // 照片：写文件 → 读回一致 → 删除行同时删文件
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
    const file = savePhotoFile(image, "image/png");
    const phId = addPhotoRow(db, p, file);
    assert.ok(isValidPhotoFilename(file));
    assert.deepEqual(readPhotoFile(file), image);
    assert.equal(extFromMime("image/webp"), "webp");
    assert.equal(contentTypeOf(file), "image/png");
    assert.equal(deletePhoto(db, phId), file);
    removePhotoFile(file);
    assert.equal(readPhotoFile(file), null);

    // 级联：删地点 → 链接消失
    deletePlace(db, p);
    t = getTrip(db, tripId)!;
    const linkCount = (db.prepare(`SELECT COUNT(*) AS n FROM place_links`).get() as { n: number }).n;
    assert.equal(linkCount, 0);
    assert.equal(t.days[0].places.length, 0);
  } finally {
    db.close();
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("photo filename whitelist blocks traversal and bad extensions", () => {
  assert.equal(isValidPhotoFilename("abc123.jpg"), true);
  assert.equal(isValidPhotoFilename("abc123.png"), true);
  assert.equal(isValidPhotoFilename("abc123.webp"), true);
  assert.equal(isValidPhotoFilename("..%2f..%2fetc%2fpasswd"), false);
  assert.equal(isValidPhotoFilename("../secrets.db"), false);
  assert.equal(isValidPhotoFilename("a.gif"), false);
  assert.equal(readPhotoFile("../../package.json"), null);
  assert.throws(() => savePhotoFile(Buffer.from("x"), "image/gif"));
});

test("platform detection covers major CN/intl sites and falls back", () => {
  const cases: Array<[string, string]> = [
    ["https://www.xiaohongshu.com/explore/1", "xiaohongshu"],
    ["http://xhslink.com/a1", "xiaohongshu"],
    ["https://v.douyin.com/iA/", "douyin"],
    ["https://www.bilibili.com/video/BV1", "bilibili"],
    ["https://b23.tv/x", "bilibili"],
    ["https://m.dianping.com/shop/1", "dianping"],
    ["https://www.youtube.com/watch?v=1", "youtube"],
    ["https://youtu.be/1", "youtube"],
    ["https://maps.app.goo.gl/abc", "googlemaps"],
    ["https://uri.amap.com/marker", "amap"],
    ["https://mp.weixin.qq.com/s/abc", "wechat"],
    ["https://weibo.com/u/1", "weibo"],
    ["some random text", "link"],
  ];
  for (const [url, expected] of cases) {
    assert.equal(detectPlatform(url).id, expected, url);
  }
  assert.equal(platformById("nope").id, "link");
});

test("global visit order = day order then place order (map numbering source)", () => {
  const db = openTravelDB();
  try {
    const tripId = createTrip(db, { title: "顺序行程" });
    const d1 = addDay(db, tripId);
    const d2 = addDay(db, tripId);
    addPlace(db, tripId, d1, "A");
    addPlace(db, tripId, d2, "B");
    addPlace(db, tripId, d1, "C");
    moveDay(db, d2, -1); // d2 变成第一天
    const t = getTrip(db, tripId)!;
    const ordered: string[] = [];
    for (const day of t.days) for (const p of day.places) ordered.push(p.name);
    assert.deepEqual(ordered, ["B", "A", "C"]);
  } finally {
    db.close();
  }
});

test("normalizeUrl prepends https and rejects empties", () => {
  assert.equal(normalizeUrl("dianping.com/shop/1"), "https://dianping.com/shop/1");
  assert.equal(normalizeUrl(" https://a.b/c "), "https://a.b/c");
  assert.throws(() => normalizeUrl(""));
  assert.throws(() => normalizeUrl("   "));
});


test("place ownership, atomic create, empty reorder and loose covers", () => {
  const db = openTravelDB();
  try {
    const trip1 = createTrip(db, { title: "行程一" });
    const trip2 = createTrip(db, { title: "行程二" });
    const day1 = getTrip(db, trip1)!.days[0].id;
    const day2 = getTrip(db, trip2)!.days[0].id;
    assert.throws(() => addPlace(db, trip1, day2, "跨行程地点"), /不属于/);
    assert.throws(() => addPlace(db, trip1, day1, "非法坐标", { lat: 999, lng: 100 }));
    assert.equal(getTrip(db, trip1)!.days[0].places.length, 0);
    assert.doesNotThrow(() => reorderPlaces(db, day1, []));
    const p = addPlace(db, trip1, day1, "地点", { note: "一起保存", cost: "120" });
    assert.equal(getTrip(db, trip1)!.days[0].places[0].note, "一起保存");
    addPhotoRow(db, p, "test.png");
    movePlace(db, p, null);
    assert.equal(listTripSummaries(db).find((t) => t.id === trip1)!.coverFile, "test.png");
    assert.deepEqual(deletePlace(db, p), ["test.png"]);
    const next = addPlace(db, trip1, day1, "另一地点");
    addPhotoRow(db, next, "other.png");
    assert.deepEqual(deleteTrip(db, trip1), ["other.png"]);
    assert.equal(getTrip(db, trip2)!.days[0].id, day2);
  } finally { db.close(); }
});

test("URL protocols, host boundaries and text limits are validated", () => {
  for (const url of ["javascript://example.com", "file:///etc/passwd", "data:text/html,test", "https://", "some random text", "https://user:pass@example.com"]) {
    assert.throws(() => normalizeUrl(url), url);
  }
  assert.equal(detectPlatform("https://xiaohongshu.com.evil.example/test").id, "link");
  assert.equal(detectPlatform("https://example.com/?url=https://xhslink.com/test").id, "link");
  assert.equal(detectPlatform("https://j.amap.com/test").id, "amap");
  const db = openTravelDB();
  try {
    assert.throws(() => createTrip(db, { title: "x".repeat(81) }));
    assert.throws(() => createTrip(db, { title: "日期", startDate: "2026-02-30" }));
    const id = createTrip(db, { title: "合法" });
    const dayId = getTrip(db, id)!.days[0].id;
    const p = addPlace(db, id, dayId, "地点");
    assert.throws(() => updatePlace(db, p, { lat: NaN, lng: 100 }));
    assert.throws(() => updatePlace(db, p, { note: "x".repeat(2001) }));
    assert.equal(getTrip(db, id)!.days[0].places[0].note, "");
  } finally { db.close(); }
});
