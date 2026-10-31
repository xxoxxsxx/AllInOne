// 极简 ZIP 写入器（零依赖）：只为证件备份导出实现最小的必要子集——store（不压缩）存储。
// 结构：[本地文件头(30B+文件名)+数据]×n + 集中目录(46B+文件名)×n + EOCD(22B)。
// 约束（超限直接抛错，绝不静默截断；不实现 ZIP64）：
// - 单个条目数据 >4GiB、归档总尺寸 >4GiB、条目数 >65535 均不支持；
// - 文件名一律按 UTF-8 写入并置通用标志 bit 11（0x0800），提示解包方按 UTF-8 解码；
// - 条目名不允许重复、绝对路径、".." 路径段、反斜杠与空字节（防路径穿越/防覆盖）。

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800; // 通用标志位 bit 11：语言编码标记（UTF-8）
const STORE_METHOD = 0; // 0 = store，不压缩
const VERSION_NEEDED = 20; // 2.0 即满足 store + UTF-8 标志
const VERSION_MADE_BY = 20;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

export type ZipEntry = { name: string; data: Uint8Array; timestamp?: Date };

// CRC-32（IEEE 802.3，多项式 0xEDB88320 反射形式）查表，与 zlib/PKZIP 一致。
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 把任意 Uint8Array 视图挂进拼接列表（Buffer 直接复用，否则零复制视图）。
function dataView(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

// DOS 时间戳（本地时间语义）。年份域自 1980 起、止于 2107：越界时整体截断到边界时刻
// （早于 1980 → 1980-01-01 00:00:00，晚于 2107 → 2107-12-31 23:59:58），不做混合截断。
function dosTimeDate(t: Date): { time: number; date: number } {
  if (!(t instanceof Date) || Number.isNaN(t.getTime())) throw new Error("ZIP 条目时间戳无效");
  const year = t.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) {
    return { time: (23 << 11) | (59 << 5) | 29, date: ((2107 - 1980) << 9) | (12 << 5) | 31 };
  }
  const month = t.getMonth() + 1;
  const day = t.getDate();
  const hours = t.getHours();
  const minutes = t.getMinutes();
  const seconds = Math.min(59, t.getSeconds());
  return {
    time: (hours << 11) | (minutes << 5) | Math.floor(seconds / 2),
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function checkEntryName(name: string): void {
  if (typeof name !== "string" || name.length === 0) throw new Error("ZIP 条目名不能为空");
  if (name.includes("\u0000")) throw new Error(`ZIP 条目名不能包含空字节：${JSON.stringify(name)}`);
  if (name.startsWith("/")) throw new Error(`ZIP 条目名不能是绝对路径：${JSON.stringify(name)}`);
  if (name.includes("\\")) throw new Error(`ZIP 条目名必须使用 "/" 分隔：${JSON.stringify(name)}`);
  if (name.split("/").some((seg) => seg === "..")) {
    throw new Error(`ZIP 条目名不允许 ".." 路径段：${JSON.stringify(name)}`);
  }
}

/**
 * 打包全部条目为 ZIP Buffer（store 存储，顺序保持入参顺序）。
 * 空数组产出仅含 EOCD 的合法空归档。任何超限/非法输入抛 Error。
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  if (!Array.isArray(entries)) throw new Error("ZIP 条目列表必须是数组");
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`ZIP 不支持超过 ${MAX_ENTRIES} 个条目（${entries.length} 个，未实现 ZIP64）`);
  }
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0; // 下一个本地头的起始偏移

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") throw new Error("ZIP 条目必须是对象");
    checkEntryName(entry.name);
    if (seen.has(entry.name)) throw new Error(`ZIP 条目名重复：${JSON.stringify(entry.name)}`);
    seen.add(entry.name);

    // 用 byteLength 判定尺寸（对真实 TypedArray 与测试注入的超限桩一致）。
    const raw: Uint8Array | null | undefined = entry.data;
    if (raw === null || raw === undefined) {
      throw new Error(`ZIP 条目数据无效：${JSON.stringify(entry.name)}`);
    }
    const size = raw.byteLength;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`ZIP 条目数据无效：${JSON.stringify(entry.name)}`);
    }
    if (size > MAX_UINT32) {
      throw new Error(`ZIP 不支持超过 4GiB 的条目（${size} 字节）：${JSON.stringify(entry.name)}`);
    }

    const nameBytes = Buffer.from(entry.name, "utf8");
    if (nameBytes.length > MAX_UINT16) {
      throw new Error(`ZIP 条目名过长（${nameBytes.length} 字节，上限 ${MAX_UINT16}）：${JSON.stringify(entry.name)}`);
    }
    const { time, date } = dosTimeDate(entry.timestamp ?? new Date());

    // 归档总尺寸 >4GiB 不支持（本地头 + 数据 + 集中目录 + EOCD 必须都能放进 uint32 偏移）。
    const entrySpan = 30 + nameBytes.length + size;
    if (offset + entrySpan > MAX_UINT32) {
      throw new Error(`ZIP 不支持总尺寸超过 4GiB 的归档（未实现 ZIP64）`);
    }
    const crc = crc32(raw);
    const localOffset = offset;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(STORE_METHOD, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // 压缩尺寸（store → 等于原始尺寸）
    local.writeUInt32LE(size, 22); // 原始尺寸
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra 字段长度
    nameBytes.copy(local, 30);
    locals.push(local, dataView(raw)); // 本地头 + 条目数据（原样字节，不复制）

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(STORE_METHOD, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(localOffset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += entrySpan;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  if (offset + centralSize + 22 > MAX_UINT32) {
    throw new Error("ZIP 不支持总尺寸超过 4GiB 的归档（未实现 ZIP64）");
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // 本盘号
  eocd.writeUInt16LE(0, 6); // 集中目录所在盘
  eocd.writeUInt16LE(entries.length, 8); // 本盘条目数
  eocd.writeUInt16LE(entries.length, 10); // 条目总数
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // 集中目录起始偏移
  eocd.writeUInt16LE(0, 20); // 注释长度
  return Buffer.concat([...locals, ...centrals, eocd]);
}
