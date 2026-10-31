// zip.ts 回归：CRC32 已知向量 + zlib 交叉验证、ZIP 结构（EOCD/集中目录/本地头）、
// 尺寸与偏移自洽、UTF-8 文件名（标志 bit 11）、超限抛错（>4GiB、条目数）、
// 重名/非法条目名拒绝、时间戳截断与确定性。

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { buildZip, crc32 } from "../src/lib/documents/zip.ts";
import { parseZip } from "./documents-zip-parser.ts";

// 确定性伪随机字节（避免依赖 Math.random 导致回归不可复现）。
function pseudoRandomBytes(length: number, seed = 0x9e3779b9): Buffer {
  const out = Buffer.alloc(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

test("crc32 matches published known vectors", () => {
  assert.equal(crc32(Buffer.alloc(0)), 0x00000000);
  assert.equal(crc32(Buffer.from("a", "utf8")), 0xe8b7be43);
  assert.equal(crc32(Buffer.from("abc", "utf8")), 0x352441c2);
  assert.equal(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926); // 标准校验值
  assert.equal(crc32(Buffer.from("The quick brown fox jumps over the lazy dog", "utf8")), 0x414fa339);
});

test("crc32 agrees with Node zlib on binary and larger data", () => {
  const seq = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.equal(crc32(seq), zlib.crc32(seq));
  const random1m = pseudoRandomBytes(1024 * 1024);
  assert.equal(crc32(random1m), zlib.crc32(random1m));
  const allZero = Buffer.alloc(8192);
  assert.equal(crc32(allZero), zlib.crc32(allZero));
  // zlib.crc32 增量语义与单次调用一致（覆盖拼接输入的正确性）。
  const [head, tail] = [random1m.subarray(0, 500000), random1m.subarray(500000)];
  assert.equal(crc32(Buffer.concat([head, tail])), zlib.crc32(tail, zlib.crc32(head)));
});

test("buildZip produces a structurally valid store-only archive with exact bytes", () => {
  const hello = Buffer.from("hello", "utf8");
  const binary = pseudoRandomBytes(4096, 42);
  const empty = Buffer.alloc(0);
  const zip = buildZip([
    { name: "a.txt", data: hello, timestamp: new Date("2026-11-01T08:30:15+08:00") },
    { name: "dir/b.bin", data: binary, timestamp: new Date("2026-11-01T08:30:15+08:00") },
    { name: "dir/empty.bin", data: empty, timestamp: new Date("2026-11-01T08:30:15+08:00") },
  ]);

  const parsed = parseZip(zip);
  assert.equal(parsed.entryCount, 3);
  assert.equal(parsed.diskEntries, 3);
  assert.deepEqual(
    parsed.entries.map((e) => e.name),
    ["a.txt", "dir/b.bin", "dir/empty.bin"],
  );
  const byName = new Map(parsed.entries.map((e) => [e.name, e]));
  assert.equal(byName.get("a.txt")!.data.toString("utf8"), "hello");
  assert.deepEqual(byName.get("dir/b.bin")!.data, binary);
  assert.equal(byName.get("dir/empty.bin")!.data.length, 0);
  for (const e of parsed.entries) {
    assert.equal(e.method, 0);
    assert.equal(e.compressedSize, e.size);
    assert.ok(e.utf8Flag);
    assert.equal(e.crc, zlib.crc32(e.data));
    // 集中目录登记的本地头偏移必须真的指向对应本地头（parseZip 已按它读到数据）。
    assert.ok(Number.isInteger(e.localOffset) && e.localOffset >= 0);
  }
  // 布局尺寸：2×(30+名+数据) + 2×(46+名) + 22。
  const expectedSize =
    (30 + "a.txt".length + hello.length) +
    (30 + "dir/b.bin".length + binary.length) +
    (30 + "dir/empty.bin".length + 0) +
    (46 + "a.txt".length) +
    (46 + "dir/b.bin".length) +
    (46 + "dir/empty.bin".length) +
    22;
  assert.equal(zip.length, expectedSize);
  assert.equal(parsed.centralOffset, expectedSize - 22 - parsed.centralSize);
});

test("buildZip stores UTF-8 filenames with bit 11 and round-trips them", () => {
  const names = ["证件/护照 扫描件.pdf", "标签😀目录/名前.txt", "β-important/なまえ.dat", "backup/manifest.json"];
  const payload = Buffer.from("célestín content", "utf8");
  const zip = buildZip(names.map((name) => ({ name, data: payload })));
  const parsed = parseZip(zip);
  assert.deepEqual(
    parsed.entries.map((e) => e.name),
    names,
  );
  for (const e of parsed.entries) {
    assert.ok(e.utf8Flag, `条目 ${e.name} 必须置 UTF-8 标志`);
    assert.equal(e.crc, zlib.crc32(payload));
    assert.equal(e.size, payload.length);
  }
});

test("buildZip with zero entries yields a valid 22-byte empty archive", () => {
  const zip = buildZip([]);
  assert.equal(zip.length, 22);
  const parsed = parseZip(zip);
  assert.equal(parsed.entryCount, 0);
  assert.equal(parsed.centralSize, 0);
  assert.equal(parsed.centralOffset, 0);
});

test("buildZip rejects duplicate entry names", () => {
  const data = Buffer.from("x");
  assert.throws(() => buildZip([{ name: "files/a.jpg", data }, { name: "files/a.jpg", data }]), /重复/);
});

test("buildZip rejects unsafe or malformed entry names", () => {
  const data = Buffer.from("x");
  for (const bad of ["", "/abs.txt", "a/../b.txt", "../escape.txt", "dir/..", "a\\b.txt", "nul\u0000.txt"]) {
    assert.throws(() => buildZip([{ name: bad, data }]), /条目名/, `条目名 ${JSON.stringify(bad)} 必须被拒绝`);
  }
});

test("buildZip rejects entry names longer than 65535 bytes", () => {
  const longName = `${"长".repeat(40000)}.txt`; // UTF-8 下 3 字节/字符 > 65535
  assert.throws(() => buildZip([{ name: longName, data: Buffer.from("x") }]), /过长/);
});

test("buildZip throws for entries over 4GiB without allocating them", () => {
  // 用实例自身属性遮蔽 byteLength，模拟超大条目而无需真实分配 4GiB 内存。
  const fake = Buffer.from("tiny");
  Object.defineProperty(fake, "byteLength", { value: 0xffffffff + 1 });
  assert.throws(
    () => buildZip([{ name: "huge.bin", data: fake as unknown as Uint8Array }]),
    /4GiB/,
  );
});

test("buildZip throws when archive offsets would exceed 4GiB", () => {
  const a = Buffer.from("aaaa");
  const b = Buffer.from("bbbb");
  Object.defineProperty(a, "byteLength", { value: 0x80000000 }); // 2GiB
  Object.defineProperty(b, "byteLength", { value: 0x80000000 }); // 合计 > 4GiB
  assert.throws(
    () => buildZip([
      { name: "a.bin", data: a as unknown as Uint8Array },
      { name: "b.bin", data: b as unknown as Uint8Array },
    ]),
    /4GiB/,
  );
});

test("buildZip throws beyond 65535 entries", () => {
  const entries = Array.from({ length: 0xffff + 1 }, (_, i) => ({
    name: `f/${i}.txt`,
    data: Buffer.alloc(0),
  }));
  assert.throws(() => buildZip(entries), /65535/);
  // 恰好 65535 个（上限内）应成功打包。
  const ok = buildZip(entries.slice(0, 0xffff));
  assert.equal(parseZip(ok).entryCount, 0xffff);
});

test("buildZip clamps pre-1980 timestamps to the DOS epoch and packs fields", () => {
  const zip = buildZip([{ name: "old.txt", data: Buffer.from("x"), timestamp: new Date("1975-06-07T23:45:21+08:00") }]);
  const [entry] = parseZip(zip).entries;
  assert.equal(entry.dosDate, (0 << 9) | (1 << 5) | 1); // 1980-01-01
  assert.equal(entry.dosTime, 0); // 00:00:00
  const t = new Date("2026-11-01T08:30:15+08:00");
  const local = new Date(t); // 用同一时刻的本地分量推导期望值（与机器时区无关）
  const expectedDate = ((local.getFullYear() - 1980) << 9) | ((local.getMonth() + 1) << 5) | local.getDate();
  const expectedTime = (local.getHours() << 11) | (local.getMinutes() << 5) | Math.floor(local.getSeconds() / 2);
  const [normal] = parseZip(buildZip([{ name: "n.txt", data: Buffer.from("y"), timestamp: t }])).entries;
  assert.equal(normal.dosDate, expectedDate);
  assert.equal(normal.dosTime, expectedTime);
  assert.throws(() => buildZip([{ name: "x.txt", data: Buffer.from("x"), timestamp: new Date(Number.NaN) }]), /时间戳/);
});

test("buildZip is deterministic for identical entries and timestamps", () => {
  const mk = () =>
    buildZip([
      { name: "backup/manifest.json", data: Buffer.from('{"a":1}'), timestamp: new Date("2026-11-01T00:00:00Z") },
      { name: "files/abc.jpg", data: pseudoRandomBytes(1024, 7), timestamp: new Date("2026-11-01T00:00:00Z") },
    ]);
  assert.deepEqual(mk(), mk());
});
