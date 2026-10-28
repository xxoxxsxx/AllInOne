"use server";

// 旅行攻略 Server Actions：UI 全部变更入口；返回 { ok, ... } 供客户端组件处理，
// 表单类动作（新建/删除行程）用 redirect 回列表页。
// 每次变更后 revalidatePath 让 RSC 重新下发行程数据。

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  addLink,
  addPhotoRow,
  addPlace,
  addDay as appendDay,
  createTrip,
  deleteDay,
  deleteLink,
  deletePhoto,
  deletePlace,
  deleteTrip,
  getTravelDB,
  moveDay,
  movePlace,
  normalizeUrl,
  renameDay,
  reorderPlaces,
  updatePlace,
  updateTrip,
  type PlacePatch,
} from "@/lib/travel/db";
import { removePhotoFile, savePhotoFile } from "@/lib/travel/photos";

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "操作失败" };
}

function revalidateTrip(tripId: number): void {
  revalidatePath(`/travel/${tripId}`);
}

function num(value: FormDataEntryValue | null): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("参数无效");
  return n;
}

// —— 行程（表单） ——

export async function createTripAction(fd: FormData): Promise<void> {
  let tripId: number;
  try {
    tripId = createTrip(getTravelDB(), {
      title: String(fd.get("title") ?? ""),
      description: String(fd.get("description") ?? ""),
      startDate: String(fd.get("startDate") ?? ""),
    });
  } catch (e) {
    redirect(`/travel?error=${encodeURIComponent(e instanceof Error ? e.message : "创建失败")}`);
  }
  revalidatePath("/travel");
  redirect(`/travel/${tripId}`);
}

export async function deleteTripAction(fd: FormData): Promise<void> {
  try {
    deleteTrip(getTravelDB(), num(fd.get("id")));
  } catch {
    // 忽略：条目可能已被删除。
  }
  revalidatePath("/travel");
  redirect(`/travel?flash=${encodeURIComponent("行程已删除")}`);
}

// —— 行程（客户端调用） ——

export async function updateTripAction(tripId: number, patch: { title?: string; description?: string; startDate?: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    updateTrip(getTravelDB(), tripId, patch);
    revalidateTrip(tripId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 天 ——

export async function addDayAction(tripId: number, title?: string): Promise<{ ok: boolean; id?: number; error?: string }> {
  try {
    const id = appendDay(getTravelDB(), tripId, title);
    revalidateTrip(tripId);
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function renameDayAction(dayId: number, title: string): Promise<{ ok: boolean; error?: string }> {
  try {
    renameDay(getTravelDB(), dayId, title);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDayAction(dayId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    const day = db.prepare(`SELECT trip_id FROM trip_days WHERE id=?`).get(dayId) as { trip_id: number } | undefined;
    deleteDay(db, dayId);
    if (day) revalidateTrip(day.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function moveDayAction(dayId: number, dir: -1 | 1): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    const day = db.prepare(`SELECT trip_id FROM trip_days WHERE id=?`).get(dayId) as { trip_id: number } | undefined;
    moveDay(db, dayId, dir);
    if (day) revalidateTrip(day.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 地点 ——

export async function addPlaceAction(tripId: number, dayId: number | null, name: string): Promise<{ ok: boolean; id?: number; error?: string }> {
  try {
    const id = addPlace(getTravelDB(), tripId, dayId, name);
    revalidateTrip(tripId);
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function updatePlaceAction(placeId: number, patch: PlacePatch): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    updatePlace(db, placeId, patch);
    const tripId = db.prepare(`SELECT trip_id FROM places WHERE id=?`).get(placeId) as { trip_id: number } | undefined;
    if (tripId) revalidateTrip(tripId.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deletePlaceAction(placeId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    const place = db.prepare(`SELECT trip_id FROM places WHERE id=?`).get(placeId) as { trip_id: number } | undefined;
    deletePlace(db, placeId);
    if (place) revalidateTrip(place.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function reorderPlacesAction(dayId: number, orderedIds: number[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    reorderPlaces(db, dayId, orderedIds);
    const day = db.prepare(`SELECT trip_id FROM trip_days WHERE id=?`).get(dayId) as { trip_id: number } | undefined;
    if (day) revalidateTrip(day.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function movePlaceAction(placeId: number, toDayId: number | null): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    movePlace(db, placeId, toDayId);
    const tripId = db.prepare(`SELECT trip_id FROM places WHERE id=?`).get(placeId) as { trip_id: number } | undefined;
    if (tripId) revalidateTrip(tripId.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 链接 ——

export async function addLinkAction(placeId: number, url: string, title: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    const normalized = normalizeUrl(url); // 先校验，再入库
    addLink(db, placeId, normalized, title);
    const tripId = db.prepare(`SELECT trip_id FROM places WHERE id=?`).get(placeId) as { trip_id: number } | undefined;
    if (tripId) revalidateTrip(tripId.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteLinkAction(linkId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    deleteLink(getTravelDB(), linkId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 照片 ——

export async function uploadPhotosAction(placeId: number, fd: FormData): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    const db = getTravelDB();
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) return { ok: false, error: "没有可上传的图片" };
    let count = 0;
    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer());
      const name = savePhotoFile(buf, file.type || "image/jpeg");
      addPhotoRow(db, placeId, name);
      count += 1;
    }
    const tripId = db.prepare(`SELECT trip_id FROM places WHERE id=?`).get(placeId) as { trip_id: number } | undefined;
    if (tripId) revalidateTrip(tripId.trip_id);
    return { ok: true, count };
  } catch (e) {
    return fail(e);
  }
}

export async function deletePhotoAction(photoId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    const file = deletePhoto(db, photoId);
    if (file) removePhotoFile(file);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
