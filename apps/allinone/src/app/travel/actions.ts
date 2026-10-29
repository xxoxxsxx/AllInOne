"use server";

// 旅行攻略 Server Actions：UI 全部变更入口；返回 { ok, ... } 供客户端组件处理，
// 表单类动作（新建/删除行程）用 redirect 回列表页。
// 每次变更后 revalidatePath 让 RSC 重新下发行程数据。

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  addLink,
  addPlace,
  batchAddPlaces,
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
  addTransport,
  deleteTransport,
  setPreferredTransport,
  updateTransport,
  setRouteColor,
  type TransportInput,
  type PlacePatch,
} from "@/lib/travel/db";
import { removePhotoFile, removePhotoFiles } from "@/lib/travel/photos";
import { uploadPlacePhotos } from "@/lib/travel/photo-service";

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "操作失败" };
}

function revalidateTrip(tripId: number): void {
  revalidatePath(`/travel/${tripId}`);
  revalidatePath("/travel");
}

function num(value: FormDataEntryValue | null): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("参数无效");
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
    removePhotoFiles(deleteTrip(getTravelDB(), num(fd.get("id"))));
  } catch (e) {
    redirect(`/travel?error=${encodeURIComponent(e instanceof Error ? e.message : "删除失败")}`);
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
    const db = getTravelDB();
    const day = db.prepare(`SELECT trip_id FROM trip_days WHERE id=?`).get(dayId) as { trip_id: number } | undefined;
    renameDay(db, dayId, title);
    if (day) revalidateTrip(day.trip_id);
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

export async function addPlaceAction(tripId: number, dayId: number | null, name: string, patch: PlacePatch = {}): Promise<{ ok: boolean; id?: number; error?: string }> {
  try {
    const id = addPlace(getTravelDB(), tripId, dayId, name, patch);
    revalidateTrip(tripId);
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function batchAddPlacesAction(tripId: number, dayId: number | null, rawText: string): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    const ids = batchAddPlaces(getTravelDB(), tripId, dayId, rawText);
    revalidateTrip(tripId);
    return { ok: true, count: ids.length };
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
    removePhotoFiles(deletePlace(db, placeId));
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
    const db = getTravelDB();
    const row = db.prepare(`SELECT p.trip_id FROM place_links l JOIN places p ON p.id=l.place_id WHERE l.id=?`).get(linkId) as { trip_id: number } | undefined;
    deleteLink(db, linkId);
    if (row) revalidateTrip(row.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 交通方案 ——

export async function addTransportAction(tripId: number, fromPlaceId: number, toPlaceId: number, input: TransportInput): Promise<{ ok: boolean; id?: number; error?: string }> {
  try {
    const id = addTransport(getTravelDB(), tripId, fromPlaceId, toPlaceId, input);
    revalidateTrip(tripId);
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function updateTransportAction(transportId: number, patch: Partial<TransportInput>): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    updateTransport(db, transportId, patch);
    const tripId = db.prepare(`SELECT trip_id FROM place_transports WHERE id=?`).get(transportId) as { trip_id: number } | undefined;
    if (tripId) revalidateTrip(tripId.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setPreferredTransportAction(transportId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    setPreferredTransport(db, transportId);
    const tripId = db.prepare(`SELECT trip_id FROM place_transports WHERE id=?`).get(transportId) as { trip_id: number } | undefined;
    if (tripId) revalidateTrip(tripId.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTransportAction(transportId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    const tripId = db.prepare(`SELECT trip_id FROM place_transports WHERE id=?`).get(transportId) as { trip_id: number } | undefined;
    deleteTransport(db, transportId);
    if (tripId) revalidateTrip(tripId.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// —— 连线颜色 ——

/** color 为空串表示恢复默认天色。 */
export async function setRouteColorAction(tripId: number, fromId: number, toId: number, color: string): Promise<{ ok: boolean; error?: string }> {
  try {
    setRouteColor(getTravelDB(), tripId, fromId, toId, color);
    revalidateTrip(tripId);
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
    if (files.length > 9 || files.reduce((sum, f) => sum + f.size, 0) > 10 * 1024 * 1024) throw new Error("每批最多 9 张、合计不超过 10MB");
    const images = [];
    for (const file of files) images.push({ data: Buffer.from(await file.arrayBuffer()), mime: file.type });
    const count = uploadPlacePhotos(db, placeId, images).length;
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
    const row = db.prepare(`SELECT p.trip_id FROM place_photos ph JOIN places p ON p.id=ph.place_id WHERE ph.id=?`).get(photoId) as { trip_id: number } | undefined;
    const file = deletePhoto(db, photoId);
    if (file) removePhotoFile(file);
    if (row) revalidateTrip(row.trip_id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
