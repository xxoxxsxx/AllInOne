// 证件夹一键备份：把全部证件数据 + 附件原始文件打包成 ZIP。
// - backup/manifest.json：完整清单（schema_version / generated_at / counts / holders /
//   categories / tags / documents / missing_files），documents 含 DB 全部字段
//   （sort_order、duration_value/duration_unit、tags、files[file,name,mime,size,is_image]），
//   可据此完整还原，不依赖运行中的数据库。
// - files/<存储 token>.<ext>：附件字节原样入包（与磁盘上完全一致）。
// 可靠性优先：附件读不到或为空字节都记入 stats.missing 与 manifest.missing_files，
// 由路由在 missing 非空时拒绝导出（500），绝不悄悄给出不完整备份。
// 体量护栏：附件 + 清单合计超过上限（默认 2GB）在打包前直接抛错。

import type Database from "better-sqlite3";

import type { DocStatus, DocumentRecord, DurationUnit } from "./db";
import { listDocuments } from "./db";
import { buildZip, type ZipEntry } from "./zip";

export const BACKUP_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export type BackupManifestFile = {
  file: string;
  name: string;
  mime: string;
  size: number;
  is_image: boolean;
  /** 实际字节与 DB 记录的 size 不一致时记录真实长度（便于发现异常，不影响打包本身）。 */
  actual_size?: number;
};

export type BackupManifestDocument = {
  id: number;
  holder_id: number | null;
  holder_name: string | null;
  category_id: number | null;
  category_name: string | null;
  title: string;
  number: string;
  issuer: string;
  start_date: string;
  expiry_date: string;
  duration_value: number | null;
  duration_unit: DurationUnit | null;
  note: string;
  sort_order: number;
  status: DocStatus;
  days_left: number | null;
  created_at: string;
  updated_at: string;
  tags: Array<{ id: number; name: string }>;
  files: BackupManifestFile[];
};

export type BackupManifest = {
  schema_version: number;
  generated_at: string;
  counts: {
    documents: number;
    files: number;
    holders: number;
    categories: number;
    tags: number;
    missing_files: number;
  };
  holders: Array<{ id: number; name: string; created_at: string }>;
  categories: Array<{ id: number; name: string; sort_order: number; created_at: string }>;
  tags: Array<{ id: number; name: string; created_at: string }>;
  documents: BackupManifestDocument[];
  missing_files: string[];
};

export type BackupStats = { documents: number; files: number; missing: string[] };

export type DocumentBackupResult = {
  zip: Buffer;
  stats: BackupStats;
  manifest: BackupManifest;
};

export type BackupOptions = {
  /** 备份时间（清单 generated_at 与 ZIP 条目时间戳）；缺省为当前时间。 */
  generatedAt?: Date;
  /** 合计字节上限（附件 + 清单）；缺省 MAX_BACKUP_BYTES。测试/调用方可收紧。 */
  maxBytes?: number;
};

/** HTTP 下载文件名：按 Asia/Shanghai 生成的 documents-backup-YYYYMMDD-HHmmss.zip。 */
export function backupFileName(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  return `documents-backup-${p("year")}${p("month")}${p("day")}-${p("hour")}${p("minute")}${p("second")}.zip`;
}

/**
 * 构建完整备份 ZIP。readAttachment 按存储文件名返回附件字节（null = 磁盘缺失）；
 * 传入 files.ts 的 readDocumentFile 即可。附件缺失不抛错、不静默省略：
 * 全部记录在 stats.missing / manifest.missing_files，由调用方（路由）决定拒绝导出。
 */
export function buildDocumentBackup(
  db: Database.Database,
  readAttachment: (file: string) => Buffer | null,
  opts: BackupOptions = {},
): DocumentBackupResult {
  const generatedAt = opts.generatedAt ?? new Date();
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    throw new Error("备份时间（generatedAt）必须是有效日期");
  }
  const maxBytes = opts.maxBytes ?? MAX_BACKUP_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("备份大小上限无效");

  // 一致性快照：全部 DB 读取 + 附件字节读取放进单个立即事务（.immediate() 拿住写锁），
  // 期间其他连接无法提交删除/修改，避免「半新半旧」的不一致备份。持锁期间磁盘上的
  // 附件文件也不会被并发清理（删除流程先提交 DB 事务再清理文件）。
  // ZIP 编码与清单序列化是纯 CPU 工作，放在锁外执行。
  const snapshot = db.transaction(() => collectBackupSnapshot(db, readAttachment)).immediate();
  const { docs, holders, categories, tags, missingSet, manifestDocs, fileEntries, fileCount } = snapshot;

  const manifest: BackupManifest = {
    schema_version: BACKUP_MANIFEST_SCHEMA_VERSION,
    generated_at: generatedAt.toISOString(),
    counts: {
      documents: docs.length,
      files: fileCount,
      holders: holders.length,
      categories: categories.length,
      tags: tags.length,
      missing_files: missingSet.size,
    },
    holders,
    categories,
    tags,
    documents: manifestDocs,
    missing_files: [...missingSet].sort(),
  };

  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const totalBytes = manifestBytes.length + fileEntries.reduce((n, e) => n + e.data.length, 0);
  if (totalBytes > maxBytes) {
    throw new Error(
      `备份合计 ${totalBytes} 字节，超过 ${maxBytes} 字节上限，请先缩减附件规模（导出已取消，未生成不完整备份）`,
    );
  }

  const entries: ZipEntry[] = [
    { name: "backup/manifest.json", data: manifestBytes, timestamp: generatedAt },
    ...fileEntries.map((e) => ({ name: e.name, data: e.data, timestamp: generatedAt })),
  ];
  const zip = buildZip(entries);
  return {
    zip,
    stats: { documents: docs.length, files: fileCount, missing: manifest.missing_files },
    manifest,
  };
}

/** 事务内执行的一致性快照收集：DB 全量读取 + 附件字节收集，不做任何纯 CPU 的编码工作。 */
type BackupSnapshot = {
  docs: DocumentRecord[];
  holders: BackupManifest["holders"];
  categories: BackupManifest["categories"];
  tags: BackupManifest["tags"];
  missingSet: Set<string>;
  manifestDocs: BackupManifestDocument[];
  fileEntries: Array<{ name: string; data: Buffer }>;
  fileCount: number;
};

function collectBackupSnapshot(
  db: Database.Database,
  readAttachment: (file: string) => Buffer | null,
): BackupSnapshot {
  const docs = listDocuments(db);
  const sortOrders = new Map<number, number>(
    (db.prepare(`SELECT id, sort_order FROM documents`).all() as Array<{ id: number; sort_order: number }>).map(
      (r) => [r.id, r.sort_order],
    ),
  );
  const holders = db
    .prepare(`SELECT id,name,created_at FROM holders ORDER BY id`)
    .all() as BackupManifest["holders"];
  const categories = db
    .prepare(`SELECT id,name,sort_order,created_at FROM categories ORDER BY id`)
    .all() as BackupManifest["categories"];
  const tags = db.prepare(`SELECT id,name,created_at FROM tags ORDER BY id`).all() as BackupManifest["tags"];

  const missingSet = new Set<string>();
  const manifestDocs: BackupManifestDocument[] = [];
  const fileEntries: Array<{ name: string; data: Buffer }> = [];
  const usedNames = new Set<string>();
  let fileCount = 0;

  for (const doc of docs) {
    const files: BackupManifestFile[] = [];
    for (const f of doc.files) {
      fileCount += 1;
      const entry: BackupManifestFile = {
        file: f.file,
        name: f.name,
        mime: f.mime,
        size: f.size,
        is_image: f.isImage,
      };
      const bytes = readAttachment(f.file);
      if (bytes === null) {
        // 磁盘缺失：记录缺失，绝不静默跳过。
        missingSet.add(f.file);
      } else if (!Buffer.isBuffer(bytes)) {
        throw new TypeError(`readAttachment 必须返回 Buffer 或 null（附件 ${JSON.stringify(f.file)}）`);
      } else if (bytes.length === 0) {
        // 空字节同样视为缺失（不完整的附件没有备份价值，且必须让导出失败）。
        missingSet.add(f.file);
      } else {
        if (bytes.length !== f.size) entry.actual_size = bytes.length;
        if (usedNames.has(f.file)) {
          throw new Error(`附件存储名冲突（${JSON.stringify(f.file)}），数据库内出现重复文件名，无法无损打包`);
        }
        usedNames.add(f.file);
        fileEntries.push({ name: `files/${f.file}`, data: bytes });
      }
      files.push(entry);
    }
    manifestDocs.push(toManifestDocument(doc, files, sortOrders.get(doc.id)));
  }

  return { docs, holders, categories, tags, missingSet, manifestDocs, fileEntries, fileCount };
}

function toManifestDocument(doc: DocumentRecord, files: BackupManifestFile[], sortOrder: number | undefined): BackupManifestDocument {
  return {
    id: doc.id,
    holder_id: doc.holderId,
    holder_name: doc.holderName,
    category_id: doc.categoryId,
    category_name: doc.categoryName,
    title: doc.title,
    number: doc.number,
    issuer: doc.issuer,
    start_date: doc.startDate,
    expiry_date: doc.expiryDate,
    duration_value: doc.durationValue,
    duration_unit: doc.durationUnit,
    note: doc.note,
    sort_order: sortOrder ?? doc.id,
    status: doc.status,
    days_left: doc.daysLeft,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
    tags: doc.tags.map((t) => ({ id: t.id, name: t.name })),
    files,
  };
}
