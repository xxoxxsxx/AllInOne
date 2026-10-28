// 旅行攻略 SQLite 存储：独立库文件 data/travel/travel.db（与台账/股票互不影响）。
// better-sqlite3 同步接口；结构：trips → trip_days → places → place_links / place_photos。
// 排序模型：天在行程内 sort_order 升序；地点在天内 sort_order 升序；
// 游览顺序 = 天顺序 + 天内地点顺序（地图编号与列表一致）。day_id 为 NULL 表示「待安排」。

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/data-dir";
import { detectPlatform } from "./platforms";

export const TRAVEL_SCHEMA_VERSION = 1;

export type PlaceLink = {
  id: number;
  url: string;
  platform: string;
  title: string;
};

export type PlacePhoto = {
  id: number;
  file: string;
};

export type Place = {
  id: number;
  tripId: number;
  dayId: number | null;
  name: string;
  lat: number | null;
  lng: number | null;
  address: string;
  timeLabel: string;
  cost: string;
  note: string;
  links: PlaceLink[];
  photos: PlacePhoto[];
};

export type TripDay = {
  id: number;
  title: string;
  places: Place[];
};

export type Trip = {
  id: number;
  title: string;
  description: string;
  startDate: string;
  days: TripDay[];
  loose: Place[]; // 未分配到天的地点
  updatedAt: string;
};

export type TripSummary = {
  id: number;
  title: string;
  description: string;
  startDate: string;
  dayCount: number;
  placeCount: number;
  coverFile: string | null;
  updatedAt: string;
};

declare global {
  var __travelSqlite: Database.Database | undefined;
}

function defaultDbPath(): string {
  return path.join(dataDir(), "travel", "travel.db");
}

export function openTravelDB(dir?: string, file = ":memory:"): Database.Database {
  const dbPath = file !== ":memory:" ? file : ":memory:";
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } else if (dir) {
    // 测试场景：内存库但需要真实文件目录（照片等）。
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function getTravelDB(): Database.Database {
  if (!globalThis.__travelSqlite) {
    globalThis.__travelSqlite = openTravelDB(undefined, defaultDbPath());
  }
  return globalThis.__travelSqlite;
}

function migrate(db: Database.Database): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version > TRAVEL_SCHEMA_VERSION) {
    throw new Error(`travel.db schema 版本过高（${version} > ${TRAVEL_SCHEMA_VERSION}），请升级程序。`);
  }
  if (version === TRAVEL_SCHEMA_VERSION) return;
  if (version < 1) {
    db.exec(`
      CREATE TABLE trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        start_date TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE trip_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE places (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        day_id INTEGER REFERENCES trip_days(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        lat REAL,
        lng REAL,
        address TEXT NOT NULL DEFAULT '',
        time_label TEXT NOT NULL DEFAULT '',
        cost TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE place_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'link',
        title TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE place_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        file TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_trip_days_trip ON trip_days(trip_id, sort_order);
      CREATE INDEX idx_places_trip ON places(trip_id, day_id, sort_order);
      CREATE INDEX idx_place_links_place ON place_links(place_id, sort_order);
      CREATE INDEX idx_place_photos_place ON place_photos(place_id, sort_order);
    `);
  }
  db.pragma(`user_version = ${TRAVEL_SCHEMA_VERSION}`);
}

function now(): string {
  return new Date().toISOString();
}

function touchTrip(db: Database.Database, tripId: number): void {
  db.prepare(`UPDATE trips SET updated_at=? WHERE id=?`).run(now(), tripId);
}

// —— 查询 ——

function loadLinks(db: Database.Database, placeIds: number[]): Map<number, PlaceLink[]> {
  const map = new Map<number, PlaceLink[]>();
  if (placeIds.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT id,place_id,url,platform,title FROM place_links
       WHERE place_id IN (${placeIds.map(() => "?").join(",")})
       ORDER BY sort_order,id`,
    )
    .all(...placeIds) as Array<{ id: number; place_id: number; url: string; platform: string; title: string }>;
  for (const r of rows) {
    const list = map.get(r.place_id) ?? [];
    list.push({ id: r.id, url: r.url, platform: r.platform, title: r.title });
    map.set(r.place_id, list);
  }
  return map;
}

function loadPhotos(db: Database.Database, placeIds: number[]): Map<number, PlacePhoto[]> {
  const map = new Map<number, PlacePhoto[]>();
  if (placeIds.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT id,place_id,file FROM place_photos
       WHERE place_id IN (${placeIds.map(() => "?").join(",")})
       ORDER BY sort_order,id`,
    )
    .all(...placeIds) as Array<{ id: number; place_id: number; file: string }>;
  for (const r of rows) {
    const list = map.get(r.place_id) ?? [];
    list.push({ id: r.id, file: r.file });
    map.set(r.place_id, list);
  }
  return map;
}

function rowToPlace(
  r: { id: number; trip_id: number; day_id: number | null; name: string; lat: number | null; lng: number | null; address: string; time_label: string; cost: string; note: string },
  links: Map<number, PlaceLink[]>,
  photos: Map<number, PlacePhoto[]>,
): Place {
  return {
    id: r.id,
    tripId: r.trip_id,
    dayId: r.day_id,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    address: r.address,
    timeLabel: r.time_label,
    cost: r.cost,
    note: r.note,
    links: links.get(r.id) ?? [],
    photos: photos.get(r.id) ?? [],
  };
}

export function getTrip(db: Database.Database, tripId: number): Trip | null {
  const trip = db.prepare(`SELECT id,title,description,start_date,updated_at FROM trips WHERE id=?`).get(tripId) as
    | { id: number; title: string; description: string; start_date: string; updated_at: string }
    | undefined;
  if (!trip) return null;

  const placeRows = db
    .prepare(`SELECT id,trip_id,day_id,name,lat,lng,address,time_label,cost,note FROM places WHERE trip_id=? ORDER BY sort_order,id`)
    .all(tripId) as Array<{ id: number; trip_id: number; day_id: number | null; name: string; lat: number | null; lng: number | null; address: string; time_label: string; cost: string; note: string }>;
  const links = loadLinks(db, placeRows.map((p) => p.id));
  const photos = loadPhotos(db, placeRows.map((p) => p.id));
  const byId = new Map<number, Place>();
  const loose: Place[] = [];
  for (const r of placeRows) {
    const place = rowToPlace(r, links, photos);
    byId.set(place.id, place);
    if (place.dayId === null) loose.push(place);
  }

  const dayRows = db
    .prepare(`SELECT id,title FROM trip_days WHERE trip_id=? ORDER BY sort_order,id`)
    .all(tripId) as Array<{ id: number; title: string }>;
  const days: TripDay[] = dayRows.map((d) => ({ id: d.id, title: d.title, places: [] }));
  const dayById = new Map(days.map((d) => [d.id, d]));
  for (const r of placeRows) {
    if (r.day_id === null) continue;
    dayById.get(r.day_id)?.places.push(byId.get(r.id)!);
  }

  return {
    id: trip.id,
    title: trip.title,
    description: trip.description,
    startDate: trip.start_date,
    days,
    loose,
    updatedAt: trip.updated_at,
  };
}

export function listTripSummaries(db: Database.Database): TripSummary[] {
  const trips = db
    .prepare(`SELECT id,title,description,start_date,updated_at FROM trips ORDER BY updated_at DESC, id DESC`)
    .all() as Array<{ id: number; title: string; description: string; start_date: string; updated_at: string }>;
  const dayCounts = new Map<number, number>(
    (db.prepare(`SELECT trip_id,COUNT(*) AS n FROM trip_days GROUP BY trip_id`).all() as Array<{ trip_id: number; n: number }>)
      .map((r) => [r.trip_id, r.n]),
  );
  const placeCounts = new Map<number, number>(
    (db.prepare(`SELECT trip_id,COUNT(*) AS n FROM places GROUP BY trip_id`).all() as Array<{ trip_id: number; n: number }>)
      .map((r) => [r.trip_id, r.n]),
  );
  // 封面：行程内第一张有照片的地点的第一张照片。
  const covers = new Map<number, string>();
  const coverRows = db
    .prepare(
      `SELECT p.trip_id AS trip_id, ph.file AS file
       FROM place_photos ph JOIN places p ON p.id = ph.place_id
       JOIN trip_days d ON d.id = p.day_id
       ORDER BY d.sort_order, p.sort_order, ph.sort_order, ph.id`,
    )
    .all() as Array<{ trip_id: number; file: string }>;
  for (const r of coverRows) {
    if (!covers.has(r.trip_id)) covers.set(r.trip_id, r.file);
  }
  return trips.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    startDate: t.start_date,
    dayCount: dayCounts.get(t.id) ?? 0,
    placeCount: placeCounts.get(t.id) ?? 0,
    coverFile: covers.get(t.id) ?? null,
    updatedAt: t.updated_at,
  }));
}

// —— 行程 ——

export function createTrip(db: Database.Database, input: { title: string; description?: string; startDate?: string }): number {
  const title = input.title.trim();
  if (!title) throw new Error("行程名称不能为空");
  const at = now();
  const create = db.transaction(() => {
    const res = db
      .prepare(`INSERT INTO trips(title,description,start_date,created_at,updated_at) VALUES(?,?,?,?,?)`)
      .run(title, (input.description ?? "").trim(), (input.startDate ?? "").trim(), at, at);
    const tripId = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO trip_days(trip_id,title,sort_order) VALUES(?,?,0)`).run(tripId, "Day 1");
    return tripId;
  });
  return create();
}

export function updateTrip(db: Database.Database, tripId: number, patch: { title?: string; description?: string; startDate?: string }): void {
  const cur = db.prepare(`SELECT title,description,start_date FROM trips WHERE id=?`).get(tripId) as
    | { title: string; description: string; start_date: string }
    | undefined;
  if (!cur) throw new Error("行程不存在");
  const title = patch.title !== undefined ? patch.title.trim() : cur.title;
  if (!title) throw new Error("行程名称不能为空");
  const description = patch.description !== undefined ? patch.description.trim() : cur.description;
  const startDate = patch.startDate !== undefined ? patch.startDate.trim() : cur.start_date;
  db.prepare(`UPDATE trips SET title=?,description=?,start_date=?,updated_at=? WHERE id=?`).run(title, description, startDate, now(), tripId);
}

export function deleteTrip(db: Database.Database, tripId: number): void {
  db.prepare(`DELETE FROM trips WHERE id=?`).run(tripId);
}

// —— 天 ——

export function addDay(db: Database.Database, tripId: number, title?: string): number {
  const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM trip_days WHERE trip_id=?`).get(tripId) as { n: number } | undefined)?.n ?? 0);
  const dayTitle = (title ?? "").trim() || `Day ${n + 1}`;
  const max = Number((db.prepare(`SELECT COALESCE(MAX(sort_order),-1) AS m FROM trip_days WHERE trip_id=?`).get(tripId) as { m: number } | undefined)?.m ?? -1);
  const res = db.prepare(`INSERT INTO trip_days(trip_id,title,sort_order) VALUES(?,?,?)`).run(tripId, dayTitle, max + 1);
  touchTrip(db, tripId);
  return Number(res.lastInsertRowid);
}

export function renameDay(db: Database.Database, dayId: number, title: string): void {
  const t = title.trim();
  if (!t) throw new Error("天名称不能为空");
  const day = db.prepare(`SELECT trip_id FROM trip_days WHERE id=?`).get(dayId) as { trip_id: number } | undefined;
  if (!day) throw new Error("天不存在");
  db.prepare(`UPDATE trip_days SET title=? WHERE id=?`).run(t, dayId);
  touchTrip(db, day.trip_id);
}

export function deleteDay(db: Database.Database, dayId: number): void {
  // 地点不删除：day_id ON DELETE SET NULL → 进入「待安排」。
  const day = db.prepare(`SELECT trip_id FROM trip_days WHERE id=?`).get(dayId) as { trip_id: number } | undefined;
  if (!day) return;
  db.prepare(`DELETE FROM trip_days WHERE id=?`).run(dayId);
  touchTrip(db, day.trip_id);
}

export function moveDay(db: Database.Database, dayId: number, dir: -1 | 1): void {
  const day = db.prepare(`SELECT id,trip_id,sort_order FROM trip_days WHERE id=?`).get(dayId) as
    | { id: number; trip_id: number; sort_order: number }
    | undefined;
  if (!day) return;
  const sibling = db
    .prepare(
      dir < 0
        ? `SELECT id,sort_order FROM trip_days WHERE trip_id=? AND sort_order<? ORDER BY sort_order DESC LIMIT 1`
        : `SELECT id,sort_order FROM trip_days WHERE trip_id=? AND sort_order>? ORDER BY sort_order ASC LIMIT 1`,
    )
    .get(day.trip_id, day.sort_order) as { id: number; sort_order: number } | undefined;
  if (!sibling) return;
  const swap = db.transaction(() => {
    db.prepare(`UPDATE trip_days SET sort_order=? WHERE id=?`).run(-1, day.id);
    db.prepare(`UPDATE trip_days SET sort_order=? WHERE id=?`).run(day.sort_order, sibling.id);
    db.prepare(`UPDATE trip_days SET sort_order=? WHERE id=?`).run(sibling.sort_order, day.id);
  });
  swap();
  touchTrip(db, day.trip_id);
}

// —— 地点 ——

export type PlacePatch = {
  name?: string;
  lat?: number | null;
  lng?: number | null;
  address?: string;
  timeLabel?: string;
  cost?: string;
  note?: string;
};

export function addPlace(db: Database.Database, tripId: number, dayId: number | null, name: string): number {
  const n = (name ?? "").trim();
  if (!n) throw new Error("地点名称不能为空");
  let sortOrder = 0;
  if (dayId !== null) {
    sortOrder = Number(
      (db.prepare(`SELECT COALESCE(MAX(sort_order),-1)+1 AS s FROM places WHERE day_id=?`).get(dayId) as { s: number } | undefined)?.s ?? 0,
    );
  }
  const res = db
    .prepare(
      `INSERT INTO places(trip_id,day_id,name,sort_order,created_at) VALUES(?,?,?,?,?)`,
    )
    .run(tripId, dayId, n, sortOrder, now());
  touchTrip(db, tripId);
  return Number(res.lastInsertRowid);
}

export function updatePlace(db: Database.Database, placeId: number, patch: PlacePatch): void {
  const cur = db.prepare(`SELECT trip_id,name,lat,lng,address,time_label,cost,note FROM places WHERE id=?`).get(placeId) as
    | { trip_id: number; name: string; lat: number | null; lng: number | null; address: string; time_label: string; cost: string; note: string }
    | undefined;
  if (!cur) throw new Error("地点不存在");
  const name = patch.name !== undefined ? patch.name.trim() : cur.name;
  if (!name) throw new Error("地点名称不能为空");
  const lat = patch.lat !== undefined ? patch.lat : cur.lat;
  const lng = patch.lng !== undefined ? patch.lng : cur.lng;
  if ((lat === null) !== (lng === null)) throw new Error("经纬度必须成对设置");
  if (lat !== null && !(Math.abs(lat) <= 90) || (lng !== null && !(Math.abs(lng!) <= 180))) {
    throw new Error("经纬度超出范围");
  }
  db.prepare(
    `UPDATE places SET name=?,lat=?,lng=?,address=?,time_label=?,cost=?,note=? WHERE id=?`,
  ).run(
    name,
    lat,
    lng,
    patch.address !== undefined ? patch.address.trim() : cur.address,
    patch.timeLabel !== undefined ? patch.timeLabel.trim() : cur.time_label,
    patch.cost !== undefined ? patch.cost.trim() : cur.cost,
    patch.note !== undefined ? patch.note : cur.note,
    placeId,
  );
  touchTrip(db, cur.trip_id);
}

export function deletePlace(db: Database.Database, placeId: number): void {
  db.prepare(`DELETE FROM places WHERE id=?`).run(placeId);
}

// 天内重排：orderedIds 必须是该天全部地点 id 的一个排列（数量一致、无重复、无陌生 id）。
export function reorderPlaces(db: Database.Database, dayId: number, orderedIds: number[]): void {
  const current = db.prepare(`SELECT id FROM places WHERE day_id=?`).all(dayId) as Array<{ id: number }>;
  const currentIds = new Set(current.map((r) => r.id));
  const orderedSet = new Set(orderedIds);
  if (
    orderedIds.length !== currentIds.size ||
    orderedSet.size !== currentIds.size ||
    !orderedIds.every((id) => currentIds.has(id))
  ) {
    throw new Error("排序数据与当天地点不一致，请刷新后重试");
  }
  const tripId = (db.prepare(`SELECT trip_id FROM places WHERE id=?`).get(orderedIds[0]) as { trip_id: number } | undefined)?.trip_id;
  const update = db.transaction(() => {
    const stmt = db.prepare(`UPDATE places SET sort_order=? WHERE id=?`);
    orderedIds.forEach((id, i) => stmt.run(i, id));
  });
  update();
  if (tripId) touchTrip(db, tripId);
}

export function movePlace(db: Database.Database, placeId: number, toDayId: number | null): void {
  const place = db.prepare(`SELECT trip_id,day_id FROM places WHERE id=?`).get(placeId) as
    | { trip_id: number; day_id: number | null }
    | undefined;
  if (!place) throw new Error("地点不存在");
  if (toDayId !== null) {
    const day = db.prepare(`SELECT trip_id FROM trip_days WHERE id=?`).get(toDayId) as { trip_id: number } | undefined;
    if (!day || day.trip_id !== place.trip_id) throw new Error("目标天不属于该行程");
  }
  let sortOrder = 0;
  if (toDayId !== null) {
    sortOrder = Number((db.prepare(`SELECT COALESCE(MAX(sort_order),-1)+1 AS s FROM places WHERE day_id=?`).get(toDayId) as { s: number } | undefined)?.s ?? 0);
  }
  db.prepare(`UPDATE places SET day_id=?, sort_order=? WHERE id=?`).run(toDayId, sortOrder, placeId);
  touchTrip(db, place.trip_id);
}

// —— 链接 ——

export function normalizeUrl(raw: string): string {
  let url = (raw ?? "").trim();
  if (!url) throw new Error("链接不能为空");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  if (url.length > 2048) throw new Error("链接过长");
  return url;
}

export function addLink(db: Database.Database, placeId: number, rawUrl: string, title = ""): number {
  const place = db.prepare(`SELECT trip_id FROM places WHERE id=?`).get(placeId) as { trip_id: number } | undefined;
  if (!place) throw new Error("地点不存在");
  const url = normalizeUrl(rawUrl);
  const platform = detectPlatform(url).id;
  const sortOrder = Number((db.prepare(`SELECT COALESCE(MAX(sort_order),-1)+1 AS s FROM place_links WHERE place_id=?`).get(placeId) as { s: number } | undefined)?.s ?? 0);
  const res = db
    .prepare(`INSERT INTO place_links(place_id,url,platform,title,sort_order) VALUES(?,?,?,?,?)`)
    .run(placeId, url, platform, (title ?? "").trim().slice(0, 200), sortOrder);
  touchTrip(db, place.trip_id);
  return Number(res.lastInsertRowid);
}

export function deleteLink(db: Database.Database, linkId: number): void {
  const link = db.prepare(`SELECT p.trip_id AS trip_id FROM place_links l JOIN places p ON p.id=l.place_id WHERE l.id=?`).get(linkId) as
    | { trip_id: number }
    | undefined;
  db.prepare(`DELETE FROM place_links WHERE id=?`).run(linkId);
  if (link) touchTrip(db, link.trip_id);
}

// —— 照片 ——

export function addPhotoRow(db: Database.Database, placeId: number, file: string): number {
  const place = db.prepare(`SELECT trip_id FROM places WHERE id=?`).get(placeId) as { trip_id: number } | undefined;
  if (!place) throw new Error("地点不存在");
  const sortOrder = Number((db.prepare(`SELECT COALESCE(MAX(sort_order),-1)+1 AS s FROM place_photos WHERE place_id=?`).get(placeId) as { s: number } | undefined)?.s ?? 0);
  const res = db.prepare(`INSERT INTO place_photos(place_id,file,sort_order,created_at) VALUES(?,?,?,?)`).run(placeId, file, sortOrder, now());
  touchTrip(db, place.trip_id);
  return Number(res.lastInsertRowid);
}

export function deletePhoto(db: Database.Database, photoId: number): string | null {
  const row = db.prepare(`SELECT file FROM place_photos WHERE id=?`).get(photoId) as { file: string } | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM place_photos WHERE id=?`).run(photoId);
  return row.file;
}

export function getTripIdOfPlace(db: Database.Database, placeId: number): number | null {
  const row = db.prepare(`SELECT trip_id FROM places WHERE id=?`).get(placeId) as { trip_id: number } | undefined;
  return row?.trip_id ?? null;
}

export function touchTripById(db: Database.Database, tripId: number): void {
  touchTrip(db, tripId);
}
