import test from "node:test";
import assert from "node:assert/strict";
import { ExportAbortedError, layoutTrip, paginateBlocks, projectPoints, wrapText, type ExportBlock } from "../src/lib/travel/export-image.ts";
import type { Trip, Place } from "../src/lib/travel/db.ts";
const measure = (s: string, size = 10) => Array.from(s).length * size;
const place = (id: number): Place => ({ id, tripId: 1, dayId: 1, name: `地点${id}`, lat: 22.3, lng: 114.2, address: "地址", timeLabel: "上午", cost: "100", note: "完整备注\n第二行", links: [{ id: 1, title: "攻略链接", url: "https://example.com/攻略", platform: "link" }], photos: [1, 2, 3, 4].map(n => ({ id: n, file: `image${n}.png` })) });
const trip: Trip = { id: 1, title: "香港", description: "测试完整行程", startDate: "2026-10-29", days: [{ id: 1, title: "Day 1", places: [place(1)] }, { id: 2, title: "Day 2", places: [place(2)] }], loose: [{ ...place(3), dayId: null, lat: null, lng: null }], transports: [], updatedAt: "" };

test("Unicode wrapping preserves astral code points, blank lines and complete URLs", () => {
  const input = "甲😀乙丙\n\nhttps://example.com/很长的网址";
  const lines = wrapText(input, 30, s => measure(s));
  assert.deepEqual(lines.slice(0, 3), ["甲😀乙", "丙", ""]);
  assert.equal(lines.join("").replaceAll("\n", ""), input.replaceAll("\n", ""));
  assert.ok(lines.every(line => Array.from(line).length <= 3));
});

test("pagination conserves blocks, exact boundary and rejects excessive output", () => {
  const blocks: ExportBlock[] = Array.from({ length: 11 }, (_, i) => ({ kind: "text", text: String(i), size: 10, color: "#000", height: 100 }));
  const pages = paginateBlocks(blocks, 660, 3); // 500px usable
  assert.deepEqual(pages.map(p => p.blocks.length), [5, 5, 1]);
  assert.deepEqual(pages.flatMap(p => p.blocks), blocks);
  assert.ok(pages.every(p => p.height <= 660));
  assert.throws(() => paginateBlocks(blocks, 660, 2), /最多导出/);
  assert.throws(() => paginateBlocks([{ ...blocks[0], height: 501 }], 660), /超出/);
  assert.throws(() => paginateBlocks([{ ...blocks[0], height: Infinity }]), /超出/);
});

test("layout includes every field, global numbers, dates, loose places and limited photos", () => {
  const pages = layoutTrip(trip, measure);
  const blocks = pages.flatMap(p => p.blocks);
  const text = blocks.filter(b => b.kind === "text").map(b => b.text).join("\n");
  for (const expected of ["香港", "测试完整行程", "2026-10-29", "2026年10月30日 · 星期五", "待安排", "1. 地点1", "2. 地点2", "3. 地点3", "上午", "¥100", "地址", "完整备注", "第二行", "攻略链接", "https://example.com/攻略", "另有 1 张照片", "未标注 1 个地点", "非道路路线"]) assert.ok(text.includes(expected), expected);
  assert.ok(blocks.filter(b => b.kind === "photos").every(b => b.files.length === 3));
  assert.equal(blocks.find(b => b.kind === "map")?.points.length, 2);
});

test("long notes paginate without dropping text lines or exceeding canvas size", () => {
  const longTrip = { ...trip, days: [{ id: 1, title: "长行程", places: Array.from({ length: 30 }, (_, i) => ({ ...place(i), photos: [], note: `备注${i}:` + "很长的备注".repeat(50) })) }], loose: [], transports: [] };
  const pages = layoutTrip(longTrip, measure);
  assert.ok(pages.length > 1);
  assert.ok(pages.every(p => p.height <= 12000));
  const text = pages.flatMap(p => p.blocks).filter(b => b.kind === "text").map(b => b.text).join("");
  for (let i = 0; i < 30; i++) assert.ok(text.includes(`备注${i}:` + "很长的备注".repeat(50)));
});

test("projection handles singleton, duplicate coordinates, poles and date line", () => {
  const points = projectPoints([{ label: "1", lat: 90, lng: 179, group: 0 }, { label: "2", lat: 90, lng: -179, group: 0 }], 968, 484);
  assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 968 && p.y >= 0 && p.y <= 484));
  const [single] = projectPoints([{ label: "1", lat: 0, lng: 0, group: 0 }], 968, 484);
  assert.equal(single.x, 484); assert.equal(single.y, 242);
  assert.deepEqual(projectPoints([], 968, 484), []);
});

test("empty trip renders one page and never shows the 待安排 group", () => {
  const empty: Trip = { id: 1, title: "空行程", description: "", startDate: "", days: [], loose: [], transports: [], updatedAt: "" };
  const pages = layoutTrip(empty, measure);
  assert.equal(pages.length, 1);
  const text = pages.flatMap(p => p.blocks).filter(b => b.kind === "text").map(b => b.text).join("\n");
  assert.ok(text.includes("空行程"));
  assert.ok(!text.includes("待安排"));
});

test("loose-only trip keeps its places under the 待安排 group", () => {
  const looseOnly: Trip = { id: 1, title: "只有待安排", description: "", startDate: "", days: [], loose: [{ ...place(9), dayId: null }], transports: [], updatedAt: "" };
  const pages = layoutTrip(looseOnly, measure);
  const text = pages.flatMap(p => p.blocks).filter(b => b.kind === "text").map(b => b.text).join("\n");
  assert.ok(text.includes("待安排"));
  assert.ok(text.includes("1. 地点9"));
  const map = pages.flatMap(p => p.blocks).find(b => b.kind === "map");
  assert.equal(map?.points.length, 1);
});

test("huge note with 4 photos stays complete, photos capped at 3", () => {
  const big: Trip = { id: 1, title: "大备注", description: "", startDate: "", updatedAt: "", days: [{ id: 1, title: "Day 1", places: [{ id: 1, tripId: 1, dayId: 1, name: "长备注", lat: 31.2, lng: 121.4, address: "", timeLabel: "", cost: "", note: "好".repeat(2000), links: [{ id: 1, url: "https://x.example/a", platform: "link", title: "l" }], photos: [1, 2, 3, 4].map(n => ({ id: n, file: `a${n}.jpg` })) }] }], loose: [], transports: [] };
  const pages = layoutTrip(big, measure);
  const blocks = pages.flatMap(p => p.blocks);
  const text = blocks.filter(b => b.kind === "text").map(b => b.text).join("");
  assert.ok(text.includes("好".repeat(2000)), "2000-char note fully preserved");
  assert.ok(text.includes("另有 1 张照片未收录"));
  const photos = blocks.filter(b => b.kind === "photos");
  assert.equal(photos.length, 1);
  assert.deepEqual(photos[0].kind === "photos" ? photos[0].files : [], ["a1.jpg", "a2.jpg", "a3.jpg"]);
});

test("ExportAbortedError is identifiable by name for silent cancellation", () => {
  const e = new ExportAbortedError();
  assert.equal(e.name, "ExportAbortedError");
  assert.ok(e instanceof Error);
});

test("layout renders transport options after each place with preferred first", () => {
  const trip = {
    id: 1, title: "交通导出", description: "", startDate: "2026-11-01", updatedAt: "",
    transports: [
      { id: 1, fromPlaceId: 101, toPlaceId: 102, mode: "地铁", duration: "25 分钟", cost: "8", note: "2号线", preferred: true },
      { id: 2, fromPlaceId: 101, toPlaceId: 102, mode: "打车", duration: "15 分钟", cost: "35", note: "", preferred: false },
      { id: 3, fromPlaceId: 102, toPlaceId: 103, mode: "轮渡", duration: "10 分钟", cost: "2", note: "", preferred: false },
    ],
    days: [
      { id: 11, title: "Day 1", places: [
        { id: 101, tripId: 1, dayId: 11, name: "码头", lat: 31.23, lng: 121.47, address: "", timeLabel: "", cost: "", note: "", links: [], photos: [] },
        { id: 102, tripId: 1, dayId: 11, name: "老街", lat: 31.24, lng: 121.48, address: "", timeLabel: "", cost: "", note: "", links: [], photos: [] },
        { id: 103, tripId: 1, dayId: 11, name: "灯塔", lat: 31.25, lng: 121.49, address: "", timeLabel: "", cost: "", note: "", links: [], photos: [] },
      ] },
    ],
    loose: [],
  } as unknown as Parameters<typeof layoutTrip>[0];
  const pages = layoutTrip(trip, () => 10);
  const all = pages.flatMap(p => p.blocks).filter(b => b.kind === "text") as Array<{ kind: "text"; text: string }>;
  const texts = all.map(b => b.text);
  assert.ok(texts.some(t => t.includes("→ 老街：地铁 · 25 分钟 · ¥8（首选）")), "preferred first: " + texts.join("|"));
  assert.ok(texts.some(t => t.includes("→ 老街：打车 · 15 分钟 · ¥35")), "second option listed");
  assert.ok(texts.some(t => t.includes("2号线")), "note rendered");
  assert.ok(texts.some(t => t.includes("→ 灯塔：轮渡 · 10 分钟 · ¥2")), "second segment rendered");
  assert.ok(!texts.some(t => t.includes("另有")), "under cap shows no overflow note");
});
