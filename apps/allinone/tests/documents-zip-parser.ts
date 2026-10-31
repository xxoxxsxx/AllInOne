// 测试专用迷你 ZIP 解析器：直接按 PKZIP 布局走 EOCD → 集中目录 → 本地头，
// 校验条目数、名称、方法、标志位、CRC 与尺寸/偏移的自洽性（store 条目数据原样返回）。
// 仅供 documents-zip / documents-backup 测试使用，不是通用解压器。

import assert from "node:assert/strict";

import { crc32 } from "../src/lib/documents/zip.ts";

export const EOCD_SIG = 0x06054b50;
export const CENTRAL_SIG = 0x02014b50;
export const LOCAL_SIG = 0x04034b50;
export const UTF8_FLAG = 0x0800;

export type ParsedEntry = {
  name: string;
  data: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  method: number;
  flags: number;
  utf8Flag: boolean;
  dosTime: number;
  dosDate: number;
  localOffset: number;
};

export type ParsedZip = {
  entries: ParsedEntry[];
  entryCount: number;
  diskEntries: number;
  centralSize: number;
  centralOffset: number;
  commentLength: number;
};

export function parseZip(zip: Buffer): ParsedZip {
  assert.ok(zip.length >= 22, "ZIP 至少要有 22 字节的 EOCD");
  const base = zip.length - 22;
  assert.equal(zip.readUInt32LE(base), EOCD_SIG, "EOCD 必须位于文件末尾");
  const diskEntries = zip.readUInt16LE(base + 8);
  const entryCount = zip.readUInt16LE(base + 10);
  const centralSize = zip.readUInt32LE(base + 12);
  const centralOffset = zip.readUInt32LE(base + 16);
  const commentLength = zip.readUInt16LE(base + 20);
  assert.equal(commentLength, 0, "不预期存在 ZIP 注释（EOCD 定位依赖无注释布局）");

  const entries: ParsedEntry[] = [];
  let p = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    assert.ok(p + 46 <= base, `集中目录头 ${i} 越过 EOCD`);
    assert.equal(zip.readUInt32LE(p), CENTRAL_SIG, `集中目录头 ${i} 签名错误`);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const dosTime = zip.readUInt16LE(p + 12);
    const dosDate = zip.readUInt16LE(p + 14);
    const crc = zip.readUInt32LE(p + 16);
    const compressedSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const { data, crc: localCrc } = readEntryData(zip, localOffset, name);
    assert.equal(localCrc, crc, `条目 ${JSON.stringify(name)} 本地头与集中目录 CRC 一致`);
    assert.equal(crc, crc32(data), `条目 ${JSON.stringify(name)} CRC 与数据一致`);
    assert.equal(method, 0, `条目 ${JSON.stringify(name)} 应为 store（method 0）`);
    assert.equal(compressedSize, size, `条目 ${JSON.stringify(name)} 压缩/原始尺寸应相等（store）`);
    assert.equal(data.length, size, `条目 ${JSON.stringify(name)} 数据长度与登记尺寸一致`);
    assert.equal((flags & UTF8_FLAG) !== 0, true, `条目 ${JSON.stringify(name)} 应置 UTF-8 标志 bit 11`);
    entries.push({
      name,
      data,
      crc,
      compressedSize,
      size,
      method,
      flags,
      utf8Flag: (flags & UTF8_FLAG) !== 0,
      dosTime,
      dosDate,
      localOffset,
    });
  }
  assert.equal(p - centralOffset, centralSize, "集中目录尺寸与 EOCD 登记一致");
  assert.equal(p, base, "集中目录必须恰好结束于 EOCD");
  return { entries, entryCount, diskEntries, centralSize, centralOffset, commentLength };
}

function readEntryData(zip: Buffer, localOffset: number, expectedName: string): { data: Buffer; crc: number } {
  assert.ok(localOffset + 30 <= zip.length, "本地文件头越界");
  assert.equal(zip.readUInt32LE(localOffset), LOCAL_SIG, `条目 ${JSON.stringify(expectedName)} 本地头签名错误`);
  const flags = zip.readUInt16LE(localOffset + 6);
  const method = zip.readUInt16LE(localOffset + 8);
  const crc = zip.readUInt32LE(localOffset + 14);
  const compressedSize = zip.readUInt32LE(localOffset + 18);
  const size = zip.readUInt32LE(localOffset + 22);
  const nameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const name = zip.toString("utf8", localOffset + 30, localOffset + 30 + nameLen);
  assert.equal(name, expectedName, "本地头与集中目录的条目名一致");
  assert.equal((flags & UTF8_FLAG) !== 0, true, "本地头也应置 UTF-8 标志 bit 11");
  assert.equal(method, 0, "本地头 method 应为 store");
  assert.equal(compressedSize, size, "本地头压缩/原始尺寸应相等");
  const data = zip.subarray(localOffset + 30 + nameLen + extraLen, localOffset + 30 + nameLen + extraLen + size);
  assert.equal(data.length, size, "本地头之后的数据长度与登记尺寸一致");
  return { data, crc };
}
