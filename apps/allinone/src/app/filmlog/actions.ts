"use server";

import { revalidatePath } from "next/cache";
import { advanceRoll, deleteImage, deleteRoll, getFilmDb, saveImage, saveRoll, type FilmInput } from "@/lib/filmlog/store";

export type Result = { ok: true } | { ok: false; error: string };
const text = (form: FormData, key: string) => String(form.get(key) ?? "");
function validId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("记录编号无效");
  return n;
}
function refresh() { revalidatePath("/filmlog"); revalidatePath("/"); }
function failure(error: unknown): Result { return { ok: false, error: error instanceof Error ? error.message : "操作失败" }; }

export async function saveRollAction(form: FormData): Promise<Result> {
  try {
    const keys: (keyof FilmInput)[] = ["brand","film","iso","format","frames","batch","purchasedAt","expiresAt","openedAt","finishedAt","sentAt","developedAt","camera","process","lab","purchasePrice","developPrice","note","status"];
    const input = Object.fromEntries(keys.map(key => [key, text(form, key)])) as FilmInput;
    const id = text(form, "id");
    saveRoll(getFilmDb(), input, id ? validId(id) : undefined);
    refresh(); return { ok: true };
  } catch (error) { return failure(error); }
}
export async function advanceRollAction(id: number): Promise<Result> {
  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    advanceRoll(getFilmDb(), validId(id), today); refresh(); return { ok: true };
  } catch (error) { return failure(error); }
}
export async function deleteRollAction(id: number): Promise<Result> {
  try { deleteRoll(getFilmDb(), validId(id)); refresh(); return { ok: true }; } catch (error) { return failure(error); }
}
export async function uploadImageAction(id: number, form: FormData): Promise<Result> {
  try {
    const file = form.get("image");
    if (!(file instanceof File) || file.size === 0) throw new Error("请选择图片");
    if (file.size > 10 * 1024 * 1024) throw new Error("单张图片不能超过 10 MB");
    saveImage(getFilmDb(), validId(id), Buffer.from(await file.arrayBuffer()), file.type, file.name);
    refresh(); return { ok: true };
  } catch (error) { return failure(error); }
}
export async function deleteImageAction(id: number, imageId: number): Promise<Result> {
  try { deleteImage(getFilmDb(), validId(id), validId(imageId)); refresh(); return { ok: true }; } catch (error) { return failure(error); }
}
