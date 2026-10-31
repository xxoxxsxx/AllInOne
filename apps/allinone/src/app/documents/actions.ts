"use server";

// 证件夹 Server Actions：UI 全部变更入口；返回 { ok, ... } 供客户端组件处理。
// 每次变更后 revalidatePath("/documents") 让 RSC 重新下发数据。

import { revalidatePath } from "next/cache";

import {
  createCategory,
  createDocument,
  createHolder,
  deleteCategory,
  deleteDocument,
  deleteDocumentFileRow,
  deleteHolder,
  deleteTag,
  getDocumentsDB,
  reorderDocuments,
  renameCategory,
  renameHolder,
  updateDocument,
  type DocumentInput,
} from "@/lib/documents/db";
import { MAX_BATCH_BYTES, MAX_FILE_BYTES, removeDocumentFile, removeDocumentFiles, uploadDocumentFiles } from "@/lib/documents/files";
import { MAX_FILES_PER_DOCUMENT } from "@/lib/documents/constants";

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "操作失败" };
}

function revalidate(): void {
  revalidatePath("/documents");
  revalidatePath("/");
}

function num(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("参数无效");
  return n;
}

// —— 证件 ——

export type SaveDocumentPayload = DocumentInput & { id?: number };

export async function saveDocumentAction(
  payload: SaveDocumentPayload,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  try {
    const input: DocumentInput = {
      holderId: payload.holderId ?? null,
      categoryId: payload.categoryId ?? null,
      title: payload.title,
      number: payload.number ?? "",
      issuer: payload.issuer ?? "",
      startDate: payload.startDate ?? "",
      expiryType: payload.expiryType,
      expiryDate: payload.expiryDate ?? "",
      durationValue: payload.durationValue,
      durationUnit: payload.durationUnit,
      note: payload.note ?? "",
      tags: payload.tags ?? [],
    };
    const db = getDocumentsDB();
    if (payload.id !== undefined && payload.id !== null) {
      const id = num(payload.id);
      updateDocument(db, id, input);
      revalidate();
      return { ok: true, id };
    }
    const id = createDocument(db, input);
    revalidate();
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDocumentAction(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const files = deleteDocument(getDocumentsDB(), num(id));
    revalidate();
    try {
      removeDocumentFiles(files);
    } catch (cleanupError) {
      console.error("证件附件文件清理失败", cleanupError);
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function uploadFilesAction(
  docId: number,
  fd: FormData,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    const id = num(docId);
    const entries = fd.getAll("files");
    if (entries.length === 0 || entries.length > MAX_FILES_PER_DOCUMENT) throw new Error(`请选择 1–${MAX_FILES_PER_DOCUMENT} 个附件`);
    let total = 0;
    for (const entry of entries) {
      if (!(entry instanceof File) || entry.size === 0) throw new Error("附件内容为空或格式无效");
      if (entry.size > MAX_FILE_BYTES) throw new Error("单个文件不能超过 10MB");
      total += entry.size;
    }
    if (total > MAX_BATCH_BYTES) throw new Error("每批附件总大小不能超过 30MB");
    const files: Array<{ data: Buffer; mime: string; name?: string }> = [];
    for (const entry of entries as File[]) {
      files.push({ data: Buffer.from(await entry.arrayBuffer()), mime: entry.type, name: entry.name });
    }
    const count = uploadDocumentFiles(getDocumentsDB(), id, files).length;
    revalidate();
    return { ok: true, count };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteFileAction(fileId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const file = deleteDocumentFileRow(getDocumentsDB(), num(fileId));
    revalidate();
    if (file) {
      try {
        removeDocumentFile(file);
      } catch (cleanupError) {
        console.error("附件文件删除失败", cleanupError);
      }
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 自由排序 ——

export async function reorderDocumentsAction(ids: number[]): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!Array.isArray(ids)) throw new Error("参数无效");
    reorderDocuments(getDocumentsDB(), ids.map((id) => num(id)));
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 持有人 ——

export async function createHolderAction(
  name: string,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  try {
    const id = createHolder(getDocumentsDB(), name);
    revalidate();
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function renameHolderAction(id: number, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    renameHolder(getDocumentsDB(), num(id), name);
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteHolderAction(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    deleteHolder(getDocumentsDB(), num(id));
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 分类 ——

export async function createCategoryAction(
  name: string,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  try {
    const id = createCategory(getDocumentsDB(), name);
    revalidate();
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function renameCategoryAction(id: number, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    renameCategory(getDocumentsDB(), num(id), name);
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteCategoryAction(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    deleteCategory(getDocumentsDB(), num(id));
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 标签 ——

export async function deleteTagAction(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    deleteTag(getDocumentsDB(), num(id));
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
