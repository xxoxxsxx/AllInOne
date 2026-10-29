"use client";

// 行程详情交互：Leaflet 示意地图（点击落点）、按天列表、拖拽排序（仅限同天，
// 跨天用编辑器的「所属天」）、地点编辑（备注/时间/花费/坐标）、链接（自动识别
// 平台）与照片（浏览器端顺序压缩上传，每地点上限 9 张）。
// 坐标统一存储 GCJ-02（高德即原始值）；OSM 渲染前 gcj→wgs、点击后 wgs→gcj。
// 所有变更走 Server Actions；RSC 重验证后 props 更新，本地 state 跟随 props。

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { Map as LeafletMap, LayerGroup, Polyline, TileLayer } from "leaflet";
import "leaflet/dist/leaflet.css";

import type { Place, TransportLeg, Trip } from "@/lib/travel/db";
import { storageToTile, tileToStorage, type TileId } from "@/lib/travel/coordinates";
import { platformById } from "@/lib/travel/platforms";
import { dayDateLabel } from "@/lib/travel/planning";
import { PhotoLightbox, type LightboxPhoto } from "./photo-lightbox";
import { BatchPlacesButton } from "./batch-places";
import { TravelExportButton } from "./export-trip";
import {
  addTransportAction,
  deleteTransportAction,
  setPreferredTransportAction,
  updateTransportAction,
} from "./actions";

import {
  addDayAction,
  addLinkAction,
  addPlaceAction,
  deleteDayAction,
  deleteLinkAction,
  deletePhotoAction,
  deletePlaceAction,
  deleteTripAction,
  moveDayAction,
  movePlaceAction,
  renameDayAction,
  reorderPlacesAction,
  updatePlaceAction,
  updateTripAction,
  uploadPhotosAction,
} from "./actions";

type Editor =
  | { mode: "add"; dayId: number | null }
  | { mode: "edit"; placeId: number }
  | null;

const DAY_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a813"];
const LOOSE_COLOR = "#5b6673";
const MAX_PHOTOS_PER_PLACE = 9;
const MAX_PHOTO_BYTES = 30 * 1024 * 1024; // 30MB/张（压缩前）
const MAX_PHOTO_PIXELS = 32 * 1024 * 1024; // 3200 万像素

function dayColor(index: number): string {
  return DAY_COLORS[index % DAY_COLORS.length];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

// 顺序压缩（避免并发解码大图爆内存）；白底填充避免透明区域在 JPEG 里变黑。
async function compressToJpeg(file: File): Promise<Blob> {
  if (file.size > MAX_PHOTO_BYTES) {
    throw new Error(`「${file.name}」超过 30MB，请先缩小再上传`);
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > MAX_PHOTO_PIXELS) {
      throw new Error(`「${file.name}」像素超过 3200 万，请先缩小再上传`);
    }
    const MAX_EDGE = 1600;
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法处理图片");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片压缩失败"))), "image/jpeg", 0.82);
    });
  } finally {
    bitmap.close();
  }
}

function formatCost(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function TravelClient({ trip: initialTrip }: { trip: Trip }) {
  const [trip, setTrip] = useState<Trip>(initialTrip);
  useEffect(() => setTrip(initialTrip), [initialTrip]);

  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);

  const [editor, setEditor] = useState<Editor>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [tile, setTile] = useState<TileId>("amap");
  const [mapReady, setMapReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);

  // 游览顺序编号：天顺序 → 天内顺序；待安排不编号（地图画灰色 ? 针）。
  const { seqOf, routeCoords, looseCoords } = (() => {
    const seq = new Map<number, number>();
    const route: Array<{ placeId: number; lat: number; lng: number; color: string; seq: number }> = [];
    const loose: Array<{ placeId: number; lat: number; lng: number }> = [];
    let n = 0;
    trip.days.forEach((day, di) => {
      day.places.forEach((p) => {
        n += 1;
        seq.set(p.id, n);
        if (p.lat !== null && p.lng !== null) {
          route.push({ placeId: p.id, lat: p.lat, lng: p.lng, color: dayColor(di), seq: n });
        }
      });
    });
    for (const p of trip.loose) {
      if (p.lat !== null && p.lng !== null) loose.push({ placeId: p.id, lat: p.lat, lng: p.lng });
    }
    return { seqOf: seq, routeCoords: route, looseCoords: loose };
  })();

  const placeById = useMemo(() => {
    const m = new Map<number, Place>();
    for (const d of trip.days) for (const p of d.places) m.set(p.id, p);
    for (const p of trip.loose) m.set(p.id, p);
    return m;
  }, [trip]);

  // 交通方案：按「起点-终点」分组（地点顺序调整后仍按对绑定，不会错配）。
  const segmentOptions = useMemo(() => {
    const m = new Map<string, TransportLeg[]>();
    const key = (from: number, to: number) => `${from}-${to}`;
    for (const t of [...trip.transports].sort((a, b) => Number(b.preferred) - Number(a.preferred))) {
      const k = key(t.fromPlaceId, t.toPlaceId);
      const list = m.get(k) ?? [];
      list.push(t);
      m.set(k, list);
    }
    return m;
  }, [trip.transports]);

  // 行程统计（含待安排）：地点数量与花费合计。
  const allPlaces = useMemo(
    () => [...trip.days.flatMap((d) => d.places), ...trip.loose],
    [trip],
  );
  const totalCost = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const p of allPlaces) {
      const n = Number.parseFloat(p.cost.replace(/[^\d.]/g, ""));
      if (Number.isFinite(n) && n > 0) {
        sum += n;
        any = true;
      }
    }
    return any ? formatCost(sum) : null;
  }, [allPlaces]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    startTransition(async () => {
      try {
        const r = await fn();
        if (!r.ok) setMsg(r.error ?? "操作失败");
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "操作失败");
      }
    });
  };

  // —— 地图 ——
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const markersRef = useRef<LayerGroup | null>(null);
  const lineRef = useRef<Polyline | null>(null);
  const layerRef = useRef<TileLayer | null>(null);
  const tileIdRef = useRef<TileId>("amap");
  const prevTileRef = useRef<TileId>("amap");
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const pickingRef = useRef<number | null>(picking);
  useEffect(() => {
    pickingRef.current = picking;
  }, [picking]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !mapElRef.current || mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(mapElRef.current, {
        center: [32.06, 118.78],
        zoom: 5,
        zoomControl: true,
      });
      mapRef.current = map;
      markersRef.current = L.layerGroup().addTo(map);
      // 容器尺寸变化（移动端旋转、sticky 布局）后重算瓦片布局。
      const ro = new ResizeObserver(() => map.invalidateSize());
      ro.observe(mapElRef.current);
      resizeObserverRef.current = ro;
      map.on("click", (e) => {
        const pid = pickingRef.current;
        if (pid == null) return;
        setPicking(null);
        // 存储统一 GCJ-02：OSM 点击（wgs）需转换后再入库。
        const storage = tileToStorage(tileIdRef.current, { lat: e.latlng.lat, lng: e.latlng.lng });
        setMsg(`已为地点设置坐标 ${storage.lat.toFixed(5)}, ${storage.lng.toFixed(5)}`);
        startTransition(async () => {
          try {
            const r = await updatePlaceAction(pid, { lat: storage.lat, lng: storage.lng });
            if (!r.ok) setMsg(r.error ?? "保存坐标失败");
          } catch (err) {
            setMsg(err instanceof Error ? err.message : "保存坐标失败");
          }
        });
      });
      setMapReady(true);
    })();
    return () => {
      cancelled = true;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current = null;
      lineRef.current = null;
      layerRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    tileIdRef.current = tile;
  }, [tile]);

  // 底图切换：先把视口中心换算到新底图坐标系（避免视角跳到别处），再换瓦片层。
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !mapReady) return;
    const prev = prevTileRef.current;
    if (prev !== tile) {
      const c = map.getCenter();
      const centerStorage = tileToStorage(prev, { lat: c.lat, lng: c.lng });
      const nextView = storageToTile(tile, centerStorage);
      map.setView([nextView.lat, nextView.lng], map.getZoom());
      prevTileRef.current = tile;
    }
    if (layerRef.current) map.removeLayer(layerRef.current);
    layerRef.current =
      tile === "amap"
        ? L.tileLayer("https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", {
            subdomains: "1234",
            maxZoom: 18,
            attribution: "© 高德地图",
          })
        : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: "© OpenStreetMap",
          });
    layerRef.current.addTo(map);
  }, [tile, mapReady]);

  // 标注与路线重绘（数据或底图变化时）。存储坐标 → 当前底图视图坐标。
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const group = markersRef.current;
    if (!L || !map || !group || !mapReady) return;
    group.clearLayers();
    if (lineRef.current) {
      map.removeLayer(lineRef.current);
      lineRef.current = null;
    }
    const editorPlaceId = editor?.mode === "edit" ? editor.placeId : null;
    const toView = (p: { lat: number; lng: number }) => storageToTile(tile, p);

    for (const c of routeCoords) {
      const isActive = editorPlaceId === c.placeId;
      const pickingHere = pickingRef.current === c.placeId;
      const v = toView(c);
      const icon = L.divIcon({
        className: "",
        html: `<div class="t-pin${isActive ? " t-pin-active" : ""}" style="--pin:${c.color}${pickingHere ? ";animation:t-pulse 1s infinite" : ""}"><span>${c.seq}</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });
      const marker = L.marker([v.lat, v.lng], { icon, title: `第 ${c.seq} 站` });
      marker.on("click", () => {
        setEditor({ mode: "edit", placeId: c.placeId });
        document.getElementById(`place-${c.placeId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      group.addLayer(marker);
    }
    // 待安排地点：灰色 ? 针（不进入路线，也不编号）。
    for (const c of looseCoords) {
      const isActive = editorPlaceId === c.placeId;
      const pickingHere = pickingRef.current === c.placeId;
      const v = toView(c);
      const icon = L.divIcon({
        className: "",
        html: `<div class="t-pin t-pin-loose${isActive ? " t-pin-active" : ""}" style="--pin:${LOOSE_COLOR}${pickingHere ? ";animation:t-pulse 1s infinite" : ""}"><span>?</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });
      const marker = L.marker([v.lat, v.lng], { icon, title: "待安排" });
      marker.on("click", () => {
        setEditor({ mode: "edit", placeId: c.placeId });
        document.getElementById(`place-${c.placeId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      group.addLayer(marker);
    }
    // 逐段画线：有交通方案的段实线 + 中点标注首选方案；无方案保持浅虚线。
    for (let i = 1; i < routeCoords.length; i += 1) {
      const a = routeCoords[i - 1], b = routeCoords[i];
      const va = toView(a), vb = toView(b);
      const key = `${a.placeId}-${b.placeId}`;
      const options = segmentOptions.get(key) ?? [];
      const pref = options.find((o) => o.preferred) ?? options[0] ?? null;
      L.polyline(
        [[va.lat, va.lng], [vb.lat, vb.lng]] as [number, number][],
        pref
          ? { color: a.color, weight: 3, opacity: 0.85 }
          : { color: "#2563eb", weight: 2, opacity: 0.65, dashArray: "6 8" },
      ).addTo(group);
      if (pref) {
        L.tooltip({
          permanent: true,
          direction: "top",
          className: "t-seg-label",
          content: `🚇 ${pref.mode}${pref.duration ? ` · ${pref.duration}` : ""}${pref.cost ? ` · ¥${pref.cost}` : ""}`,
        }).setLatLng([(va.lat + vb.lat) / 2, (va.lng + vb.lng) / 2]).addTo(group);
      }
    }
  }, [trip, tile, mapReady, editor, picking, routeCoords, looseCoords, segmentOptions]);

  const fitAll = () => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    const all = [...routeCoords, ...looseCoords];
    if (all.length === 0) return;
    if (all.length === 1) {
      const v = storageToTile(tile, all[0]);
      map.setView([v.lat, v.lng], 14);
      return;
    }
    map.fitBounds(
      L.latLngBounds(
        all.map((c) => {
          const v = storageToTile(tile, c);
          return [v.lat, v.lng] as [number, number];
        }),
      ).pad(0.2),
    );
  };
  useEffect(() => {
    if (mapReady) fitAll();
    // 仅在打开行程 / 地图就绪时自动全览，后续编辑不打断视野。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id, mapReady]);

  // —— 列表交互 ——

  // 拖拽：只允许同一天内排序；记录源 dayId/placeId/index。
  const dragFrom = useRef<{ dayId: number; placeId: number; index: number } | null>(null);

  const onDropDay = (dayId: number, toIndex: number) => {
    const src = dragFrom.current;
    dragFrom.current = null;
    if (!src) return;
    if (src.dayId !== dayId) {
      setMsg("跨天调整请打开该地点，用「所属天」选择目标天");
      return;
    }
    if (src.index === toIndex) return;
    const day = trip.days.find((d) => d.id === dayId);
    if (!day || src.index < 0 || src.index >= day.places.length) return;
    const ids = day.places.map((p) => p.id);
    const [moved] = ids.splice(src.index, 1);
    ids.splice(toIndex, 0, moved);
    const snapshot = trip; // 乐观更新失败时回滚
    setTrip((t) => ({
      ...t,
      days: t.days.map((d) =>
        d.id === dayId ? { ...d, places: ids.map((id) => d.places.find((p) => p.id === id)!) } : d,
      ),
    }));
    startTransition(async () => {
      try {
        const r = await reorderPlacesAction(dayId, ids);
        if (!r.ok) {
          setTrip(snapshot);
          setMsg(r.error ?? "排序失败");
        }
      } catch (e) {
        setTrip(snapshot);
        setMsg(e instanceof Error ? e.message : "排序失败");
      }
    });
  };

  // 移动端/无拖拽环境：同天内上移、下移。
  const movePlaceRow = (dayId: number, index: number, dir: -1 | 1) => {
    const day = trip.days.find((d) => d.id === dayId);
    if (!day) return;
    const j = index + dir;
    if (j < 0 || j >= day.places.length) return;
    const ids = day.places.map((p) => p.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(j, 0, moved);
    run(() => reorderPlacesAction(dayId, ids));
  };

  const editingPlace = editor?.mode === "edit" ? placeById.get(editor.placeId) ?? null : null;
  const pickingPlace = picking !== null ? placeById.get(picking) ?? null : null;

  // —— 照片灯箱：行程内全局有序（天顺序 → 地点顺序 → 照片顺序，含待安排） ——
  const allPhotos = useMemo<LightboxPhoto[]>(() => {
    const list: LightboxPhoto[] = [];
    const pushPlace = (dayTitle: string | null, p: Place) => {
      p.photos.forEach((ph, i) => {
        list.push({
          id: ph.id,
          url: `/api/travel/photos/${ph.file}`,
          caption: `${p.name}${dayTitle ? ` · ${dayTitle}` : ""}${p.photos.length > 1 ? ` · ${i + 1}/${p.photos.length}` : ""}`,
        });
      });
    };
    trip.days.forEach((day) => day.places.forEach((p) => pushPlace(day.title, p)));
    trip.loose.forEach((p) => pushPlace(null, p));
    return list;
  }, [trip]);
  const [lightboxPhotoId, setLightboxPhotoId] = useState<number | null>(null);
  const openPhoto = (photoId: number) => {
    if (allPhotos.some(photo => photo.id === photoId)) setLightboxPhotoId(photoId);
  };
  // If an in-flight RSC update removes the active photo, close the viewer rather
  // than silently showing the next item at its old index.
  useEffect(() => {
    if (lightboxPhotoId !== null && !allPhotos.some(photo => photo.id === lightboxPhotoId)) {
      setLightboxPhotoId(null);
    }
  }, [allPhotos, lightboxPhotoId]);

  return (
    <main className="travel-page travel-detail">
      <div className="travel-container travel-detail-grid">
        <section className="travel-map-pane" aria-label="行程地图">
          <div className="travel-map-head">
            <Link href="/travel" className="travel-back">← 行程列表</Link>
            <div className="travel-map-tools">
              <button className="btn btn-ghost btn-sm" onClick={fitAll} title="缩放到全部地点">⌖ 全览</button>
              <div className="tile-switch" role="tablist" aria-label="底图">
                <button role="tab" aria-selected={tile === "amap"} className={tile === "amap" ? "on" : ""} onClick={() => setTile("amap")}>高德</button>
                <button role="tab" aria-selected={tile === "osm"} className={tile === "osm" ? "on" : ""} onClick={() => setTile("osm")}>OSM</button>
              </div>
            </div>
          </div>
          <div className="travel-map-wrap">
            <div ref={mapElRef} className="travel-map" />
            {pickingPlace ? (
              <div className="travel-picking">
                <span>点击地图为「{pickingPlace.name}」设置坐标</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setPicking(null)}>取消</button>
              </div>
            ) : null}
          </div>
          <p className="travel-map-hint">地图仅供示意，不用于导航。在地点上选「点选坐标」后点击地图即可标注。</p>
        </section>

        <section className="travel-list-pane">
          <header className="trip-head">
            {editingHeader ? (
              <TripHeaderForm
                trip={trip}
                onCancel={() => setEditingHeader(false)}
                onSave={(patch) =>
                  run(async () => {
                    const r = await updateTripAction(trip.id, patch);
                    if (r.ok) setEditingHeader(false);
                    return r;
                  })
                }
              />
            ) : (
              <>
                <div>
                  <h1 className="trip-head-title">{trip.title}</h1>
                  <p className="trip-head-meta">
                    {trip.days.length} 天 · {allPlaces.length} 个地点
                    {totalCost ? ` · 花费合计 ¥${totalCost}` : ""}
                    {trip.startDate ? ` · ${trip.startDate} 出发` : ""}
                  </p>
                  {trip.description ? <p className="trip-head-desc">{trip.description}</p> : null}
                </div>
                <div className="trip-head-actions">
                  {allPhotos.length > 0 ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => setLightboxPhotoId(allPhotos[0].id)} title="浏览行程内全部照片">
                      📷 全部照片 {allPhotos.length}
                    </button>
                  ) : null}
                  <TravelExportButton trip={trip} />
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingHeader(true)}>编辑信息</button>
                  <form
                    className="trip-delete"
                    action={deleteTripAction}
                    onSubmit={(e) => {
                      if (!window.confirm("删除整个行程？所有天、地点、照片都会一并删除，无法恢复。")) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="id" value={trip.id} />
                    <button type="submit" className="btn btn-sm trip-delete-btn">删除行程</button>
                  </form>
                </div>
              </>
            )}
          </header>

          {msg ? <p className="travel-note">{msg}</p> : null}

          {trip.days.map((day, di) => (
            <section className="t-day" key={day.id} style={{ "--day-color": dayColor(di) } as React.CSSProperties}>
              <header className="t-day-head">
                <span className="t-day-badge">{di + 1}</span>
                <input
                  className="t-day-title"
                  defaultValue={day.title}
                  key={`${day.id}-${day.title}`}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== day.title) run(() => renameDayAction(day.id, v));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  aria-label="天名称"
                />
                <span className="t-day-actions">
                  <button className="icon-btn" title="上移" disabled={pending} onClick={() => run(() => moveDayAction(day.id, -1))}>↑</button>
                  <button className="icon-btn" title="下移" disabled={pending} onClick={() => run(() => moveDayAction(day.id, 1))}>↓</button>
                  <button
                    className="icon-btn"
                    title="删除该天（地点保留到待安排）"
                    onClick={() => {
                      if (window.confirm(`删除「${day.title}」？其中的地点会移到「待安排」。`)) run(() => deleteDayAction(day.id));
                    }}
                  >
                    🗑
                  </button>
                </span>
              </header>
              {trip.startDate ? <p className="t-day-date">{dayDateLabel(trip.startDate, di)}</p> : null}
              <ol className="t-places">
                {day.places.map((p, pi) => (
                  <Fragment key={p.id}>
                    <li
                      id={`place-${p.id}`}
                      className={`t-place${editor?.mode === "edit" && editor.placeId === p.id ? " t-place-active" : ""}`}
                      draggable
                      onDragStart={() => {
                        dragFrom.current = { dayId: day.id, placeId: p.id, index: pi };
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        onDropDay(day.id, pi);
                      }}
                    >
                    <span className="t-place-seq" title="游览顺序">{seqOf.get(p.id) ?? "·"}</span>
                    <button className="t-place-main" onClick={() => setEditor({ mode: "edit", placeId: p.id })}>
                      <span className="t-place-name">
                        {p.name}
                        {p.lat === null ? <em className="t-place-unpinned" title="尚未标注坐标">未标注</em> : null}
                      </span>
                      <span className="t-place-tags">
                        {p.timeLabel ? <em className="t-tag">{p.timeLabel}</em> : null}
                        {p.cost ? <em className="t-tag">¥{p.cost}</em> : null}
                        {p.links.slice(0, 4).map((l) => {
                          const pf = platformById(l.platform);
                          return <em key={l.id} className="t-dot" style={{ background: pf.color }} title={pf.name} />;
                        })}
                        {p.photos.length > 0 ? <em className="t-tag">🖼 {p.photos.length}</em> : null}
                        {p.note ? <em className="t-note-preview">{p.note.slice(0, 24)}</em> : null}
                      </span>
                    </button>
                    {day.places.length > 1 ? (
                      <span className="t-place-nav">
                        <button
                          className="icon-btn"
                          title="上移"
                          aria-label={`上移 ${p.name}`}
                          disabled={pending || pi === 0}
                          onClick={() => movePlaceRow(day.id, pi, -1)}
                        >
                          ▲
                        </button>
                        <button
                          className="icon-btn"
                          title="下移"
                          aria-label={`下移 ${p.name}`}
                          disabled={pending || pi === day.places.length - 1}
                          onClick={() => movePlaceRow(day.id, pi, 1)}
                        >
                          ▼
                        </button>
                      </span>
                    ) : null}
                    <span className="t-place-grip" title="拖拽排序（仅限同一天）">⋮⋮</span>
                  </li>
                    {pi < day.places.length - 1 ? (() => {
                      const nextPlace = day.places[pi + 1];
                      const key = `${p.id}-${nextPlace.id}`;
                      return (
                        <li className="t-transport-li">
                          <TransportRow
                            tripId={trip.id}
                            fromId={p.id}
                            toId={nextPlace.id}
                            fromName={p.name}
                            toName={nextPlace.name}
                            options={segmentOptions.get(key) ?? []}
                          />
                        </li>
                      );
                    })() : null}
                  </Fragment>
                ))}
                {day.places.length === 0 ? <li className="t-place-empty">这一天还没有安排，点下面添加地点。</li> : null}
              </ol>
              <div className="t-day-add-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setEditor({ mode: "add", dayId: day.id })}>＋ 添加地点</button>
                <BatchPlacesButton tripId={trip.id} dayId={day.id} dayTitle={day.title} />
              </div>
            </section>
          ))}

          {trip.loose.length > 0 ? (
            <section className="t-day t-day-loose" style={{ "--day-color": LOOSE_COLOR } as React.CSSProperties}>
              <header className="t-day-head">
                <span className="t-day-badge">?</span>
                <span className="t-day-title">待安排</span>
              </header>
              <ol className="t-places">
                {trip.loose.map((p) => (
                  <li key={p.id} id={`place-${p.id}`} className={`t-place${editor?.mode === "edit" && editor.placeId === p.id ? " t-place-active" : ""}`}>
                    <span className="t-place-seq">·</span>
                    <button className="t-place-main" onClick={() => setEditor({ mode: "edit", placeId: p.id })}>
                      <span className="t-place-name">
                        {p.name}
                        {p.lat === null ? <em className="t-place-unpinned" title="尚未标注坐标">未标注</em> : null}
                      </span>
                      <span className="t-place-tags">
                        {p.links.slice(0, 4).map((l) => {
                          const pf = platformById(l.platform);
                          return <em key={l.id} className="t-dot" style={{ background: pf.color }} title={pf.name} />;
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <div className="travel-list-foot">
            <button className="btn btn-secondary" disabled={pending} onClick={() => run(() => addDayAction(trip.id))}>＋ 添加一天</button>
          </div>
        </section>
      </div>

      {editor ? (
        <PlaceEditor
          key={editor.mode === "add" ? `add-${editor.dayId ?? "loose"}` : `edit-${editor.placeId}`}
          trip={trip}
          editor={editor}
          place={editingPlace}
          pending={pending}
          uploading={uploading}
          onClose={() => setEditor(null)}
          // 点选坐标前先保存草稿（PlaceEditor 内部处理），成功后才关闭并进入点选。
          onPicking={(placeId) => {
            setEditor(null);
            setPicking(placeId);
            document.querySelector(".travel-map-pane")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }}
          onMoveToDay={(placeId, dayId) => run(() => movePlaceAction(placeId, dayId))}
          onOpenPhoto={openPhoto}
          startUpload={async (placeId, files) => {
            const fd = new FormData();
            for (const f of files) fd.append("files", f);
            setUploading(true);
            try {
              return await uploadPhotosAction(placeId, fd);
            } catch (e) {
              return { ok: false as const, error: e instanceof Error ? e.message : "上传失败" };
            } finally {
              setUploading(false);
            }
          }}
        />
      ) : null}
      {lightboxPhotoId !== null && allPhotos.some(photo => photo.id === lightboxPhotoId) ? (
        <PhotoLightbox
          photos={allPhotos}
          photoId={lightboxPhotoId}
          onClose={() => setLightboxPhotoId(null)}
          onNavigate={setLightboxPhotoId}
        />
      ) : null}
    </main>
  );
}

// —— 行程信息编辑 ——

function TripHeaderForm({
  trip,
  onSave,
  onCancel,
}: {
  trip: Trip;
  onSave: (patch: { title: string; description: string; startDate: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(trip.title);
  const [description, setDescription] = useState(trip.description);
  const [startDate, setStartDate] = useState(trip.startDate);
  return (
    <form
      className="trip-head-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave({ title, description, startDate });
      }}
    >
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} aria-label="行程名称" required />
      <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label="出发日期" />
      <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="一句话简介" aria-label="行程简介" />
      <div className="trip-head-form-actions">
        <button type="submit" className="btn btn-primary btn-sm">保存</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}

// —— 地点编辑器（弹层） ——

type EditorNote = { kind: "error" | "ok"; text: string } | null;

function PlaceEditor({
  trip,
  editor,
  place,
  pending,
  uploading,
  onClose,
  onPicking,
  onMoveToDay,
  onOpenPhoto,
  startUpload,
}: {
  trip: Trip;
  editor: Exclude<Editor, null>;
  place: Place | null;
  pending: boolean;
  uploading: boolean;
  onClose: () => void;
  onPicking: (placeId: number) => void;
  onMoveToDay: (placeId: number, dayId: number | null) => void;
  onOpenPhoto: (photoId: number) => void;
  startUpload: (placeId: number, files: File[]) => Promise<{ ok: boolean; count?: number; error?: string }>;
}) {
  const isAdd = editor.mode === "add";
  const defaultDayId = isAdd ? editor.dayId : null;
  const [name, setName] = useState(place?.name ?? "");
  const [timeLabel, setTimeLabel] = useState(place?.timeLabel ?? "");
  const [cost, setCost] = useState(place?.cost ?? "");
  const [address, setAddress] = useState(place?.address ?? "");
  const [note, setNote] = useState(place?.note ?? "");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [editorNote, setEditorNote] = useState<EditorNote>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [modalPending, startModalTransition] = useTransition();

  // 弹层内操作：错误/成功显示在弹层内（页面级 msg 会被遮罩挡住）。
  const runModal = (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    opts?: { okNote?: string; onSuccess?: () => void },
  ) => {
    startModalTransition(async () => {
      let r: { ok: boolean; error?: string };
      try {
        r = await fn();
      } catch (e) {
        setEditorNote({ kind: "error", text: e instanceof Error ? e.message : "操作失败" });
        return;
      }
      if (!r.ok) {
        setEditorNote({ kind: "error", text: r.error ?? "操作失败" });
        return;
      }
      if (opts?.okNote) setEditorNote({ kind: "ok", text: opts.okNote });
      opts?.onSuccess?.();
    });
  };

  const busy = pending || modalPending;

  const save = () => {
    const n = name.trim();
    if (!n) {
      setEditorNote({ kind: "error", text: "地点名称不能为空" });
      return;
    }
    if (isAdd) {
      runModal(
        async () => {
          const r = await addPlaceAction(trip.id, defaultDayId, n);
          if (!r.ok || r.id === undefined) return r;
          const patch: Record<string, string> = {};
          if (timeLabel.trim()) patch.timeLabel = timeLabel;
          if (cost.trim()) patch.cost = cost;
          if (address.trim()) patch.address = address;
          if (note.trim()) patch.note = note;
          if (Object.keys(patch).length > 0) {
            const r2 = await updatePlaceAction(r.id, patch);
            if (!r2.ok) return r2;
          }
          return { ok: true };
        },
        { onSuccess: onClose },
      );
    } else if (place) {
      runModal(() => updatePlaceAction(place.id, { name, timeLabel, cost, address, note }), {
        onSuccess: onClose,
      });
    }
  };

  // 点选坐标：先保存草稿（成功才关弹层），避免丢失未保存的名称/备注等编辑。
  const startPicking = () => {
    if (!place) return;
    const n = name.trim();
    if (!n) {
      setEditorNote({ kind: "error", text: "请先填写地点名称再点选坐标" });
      return;
    }
    runModal(async () => {
      const r = await updatePlaceAction(place.id, { name: n, timeLabel, cost, address, note });
      if (!r.ok) return r;
      onClose();
      onPicking(place.id);
      return { ok: true };
    });
  };

  // 照片上传：上限 9 张；顺序压缩（避免并发解码爆内存）；错误显示在弹层内。
  const onPhotoFiles = async (fileList: FileList | null) => {
    if (!place) return;
    const files = Array.from(fileList ?? []);
    if (photoInputRef.current) photoInputRef.current.value = "";
    if (files.length === 0 || mediaBusy || uploading) return;
    setEditorNote(null);
    const existing = place.photos.length;
    const remaining = MAX_PHOTOS_PER_PLACE - existing;
    if (remaining <= 0) {
      setEditorNote({ kind: "error", text: "每个地点最多 9 张照片" });
      return;
    }
    if (files.length > remaining) {
      setEditorNote({ kind: "error", text: `照片超限：最多 9 张，还能添加 ${remaining} 张` });
      return;
    }
    for (const f of files) {
      if (f.size > MAX_PHOTO_BYTES) {
        setEditorNote({ kind: "error", text: `「${f.name}」超过 30MB，已取消上传` });
        return;
      }
    }
    setMediaBusy(true);
    try {
      const jpegs: File[] = [];
      for (let i = 0; i < files.length; i++) {
        const blob = await compressToJpeg(files[i]); // 顺序执行
        jpegs.push(new File([blob], `photo-${i}.jpg`, { type: "image/jpeg" }));
      }
      const r = await startUpload(place.id, jpegs);
      if (!r.ok) setEditorNote({ kind: "error", text: r.error ?? "上传失败" });
      else setEditorNote({ kind: "ok", text: `已上传 ${r.count} 张照片` });
    } catch (err) {
      setEditorNote({ kind: "error", text: err instanceof Error ? err.message : "图片处理失败" });
    } finally {
      setMediaBusy(false);
    }
  };

  return (
    <div className="t-modal" role="dialog" aria-modal="true" aria-label={isAdd ? "添加地点" : "编辑地点"}>
      <div className="t-modal-mask" onClick={onClose} />
      <div className="t-modal-panel">
        <header className="t-modal-head">
          <h2>{isAdd ? "添加地点" : `编辑：${place?.name ?? ""}`}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </header>

        {editorNote ? (
          <p className={`t-modal-note ${editorNote.kind === "error" ? "t-modal-note-error" : "t-modal-note-ok"}`} role="status">
            {editorNote.text}
          </p>
        ) : null}

        <div className="t-form">
          <label className="t-field">
            <span>名称</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：洱海生态廊道" maxLength={80} autoFocus={isAdd} />
          </label>
          <div className="t-field-row">
            <label className="t-field">
              <span>时间段</span>
              <input className="input" value={timeLabel} onChange={(e) => setTimeLabel(e.target.value)} placeholder="如：上午 / 14:00" maxLength={40} />
            </label>
            <label className="t-field">
              <span>花费（元）</span>
              <input className="input" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="如：120" maxLength={40} />
            </label>
          </div>
          <label className="t-field">
            <span>地址</span>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="选填" maxLength={200} />
          </label>
          <label className="t-field">
            <span>备注</span>
            <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="小贴士：预约方式、注意时间等" maxLength={2000} />
          </label>

          {!isAdd && place ? (
            <>
              <div className="t-field-row">
                <label className="t-field">
                  <span>坐标</span>
                  <span className="t-coord">
                    {place.lat !== null && place.lng !== null
                      ? `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`
                      : "未标注"}
                  </span>
                </label>
                <div className="t-field t-field-actions">
                  <span>&nbsp;</span>
                  <button className="btn btn-secondary btn-sm" disabled={busy} onClick={startPicking}>📍 在地图上点选</button>
                  {place.lat !== null ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => runModal(() => updatePlaceAction(place.id, { lat: null, lng: null }), { okNote: "已清除坐标" })}
                    >
                      清除
                    </button>
                  ) : null}
                </div>
              </div>

              <label className="t-field">
                <span>所属天</span>
                <select
                  className="input"
                  value={place.dayId ?? ""}
                  onChange={(e) => onMoveToDay(place.id, e.target.value === "" ? null : Number(e.target.value))}
                >
                  <option value="">待安排</option>
                  {trip.days.map((d, i) => (
                    <option key={d.id} value={d.id}>{`Day ${i + 1} · ${d.title}`}</option>
                  ))}
                </select>
              </label>

              <section className="t-section">
                <h3>链接</h3>
                <ul className="t-links">
                  {place.links.map((l) => {
                    const pf = platformById(l.platform);
                    return (
                      <li key={l.id}>
                        <span className="t-dot" style={{ background: pf.color }} />
                        <span className="t-link-name">{l.title || pf.name}</span>
                        <a className="t-link-host" href={l.url} target="_blank" rel="noreferrer noopener">{hostOf(l.url)}</a>
                        <button
                          className="icon-btn"
                          title="删除链接"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm("删除该链接？")) runModal(() => deleteLinkAction(l.id));
                          }}
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                  {place.links.length === 0 ? <li className="t-empty">还没有链接。粘贴小红书 / 抖音 / B站 / 点评等攻略链接。</li> : null}
                </ul>
                <div className="t-link-add">
                  <input className="input" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="粘贴链接 URL" />
                  <input className="input" value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} placeholder="备注名（选填）" maxLength={100} />
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !linkUrl.trim()}
                    onClick={() => {
                      const pid = place.id;
                      const url = linkUrl;
                      const title = linkTitle;
                      runModal(async () => {
                        const r = await addLinkAction(pid, url, title);
                        if (r.ok) {
                          setLinkUrl("");
                          setLinkTitle("");
                        }
                        return r;
                      });
                    }}
                  >
                    添加
                  </button>
                </div>
              </section>

              <section className="t-section">
                <h3>照片{place.photos.length > 0 ? `（${place.photos.length}/9）` : ""}</h3>
                <div className="t-photos">
                  {place.photos.map((ph) => (
                    <div key={ph.id} className="t-photo">
                      <button
                        type="button"
                        className="t-photo-view"
                        title="查看大图"
                        aria-label={`查看大图：${place.name} 第 ${place.photos.indexOf(ph) + 1} 张`}
                        onClick={() => onOpenPhoto(ph.id)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/travel/photos/${ph.file}`} alt="" loading="lazy" />
                      </button>
                      <button
                        className="t-photo-del"
                        title="删除照片"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm("删除该照片？")) runModal(() => deletePhotoAction(ph.id));
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    className="t-photo-add"
                    disabled={mediaBusy || uploading}
                    onClick={() => photoInputRef.current?.click()}
                  >
                    {mediaBusy ? "处理中…" : uploading ? "上传中…" : "＋ 添加"}
                  </button>
                </div>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  disabled={mediaBusy || uploading}
                  onChange={(e) => void onPhotoFiles(e.target.files)}
                />
                <p className="t-hint">每地点最多 9 张；上传前浏览器压缩到长边 1600px（单张 ≤30MB、≤3200 万像素）。</p>
              </section>

              <div className="t-danger-zone">
                <button
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`删除地点「${place.name}」及其链接与照片？`)) {
                      const pid = place.id;
                      runModal(async () => {
                        const r = await deletePlaceAction(pid);
                        if (r.ok) onClose();
                        return r;
                      });
                    }
                  }}
                >
                  删除该地点
                </button>
              </div>
            </>
          ) : null}
        </div>

        <footer className="t-modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{isAdd ? "添加" : "保存"}</button>
        </footer>
      </div>
    </div>
  );
}

// —— 相邻景点交通段：多方案（方式/耗时/费用/备注），可设首选 ——
// 绑定「起点-终点」地点对：调整顺序后仍按对匹配显示，不会错配到其他景点。

function transportSummary(o: TransportLeg): string {
  return `${o.mode}${o.duration ? ` · ${o.duration}` : ""}${o.cost ? ` · ¥${o.cost}` : ""}`;
}

function TransportRow({
  tripId,
  fromId,
  toId,
  fromName,
  toName,
  options,
}: {
  tripId: number;
  fromId: number;
  toId: number;
  fromName: string;
  toName: string;
  options: TransportLeg[];
}) {
  const [open, setOpen] = useState(false);
  const [pendingT, startTransitionT] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const preferred = options.find((o) => o.preferred) ?? options[0] ?? null;
  // 点选首选后的服务端往返期间，用本地「意向首选」保持 radio 状态不被重渲染弹回。
  const [pendingPrefId, setPendingPrefId] = useState<number | null>(null);
  const effectivePreferred = (option: TransportLeg): boolean =>
    pendingPrefId !== null ? option.id === pendingPrefId : option.preferred;
  const setPreferred = (id: number) => {
    setPendingPrefId(id);
    startTransitionT(async () => {
      const r = await setPreferredTransportAction(id);
      if (!r.ok) setErr(r.error ?? "操作失败");
      setPendingPrefId(null);
    });
  };

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    startTransitionT(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "操作失败");
      else setErr(null);
    });
  };

  return (
    <div className="t-transport">
      <button
        type="button"
        className={`t-transport-pill${options.length ? " has-options" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="编辑这段的交通方案"
      >
        <span className="t-transport-line" aria-hidden>↓</span>
        {preferred ? (
          <span className="t-transport-summary">
            {transportSummary(preferred)}
            {preferred.note ? ` · ${preferred.note.slice(0, 18)}` : ""}
          </span>
        ) : (
          <span className="t-transport-summary t-transport-empty">＋ 添加交通方案</span>
        )}
        {options.length > 1 ? <span className="t-transport-count">{options.length} 个方案</span> : null}
      </button>
      {open ? (
        <div className="t-transport-panel">
          <p className="t-transport-title">{fromName} → {toName}</p>
          {err ? <p className="t-transport-error" role="alert">{err}</p> : null}
          <ul className="t-transport-options">
            {options.map((o) => (
              <TransportOptionRow
                key={o.id}
                tripId={tripId}
                option={o}
                preferred={effectivePreferred(o)}
                pending={pendingT || (pendingPrefId !== null && pendingPrefId !== o.id)}
                onSetPreferred={() => setPreferred(o.id)}
                act={act}
              />
            ))}
            {options.length === 0 ? (
              <li className="t-transport-none">还没有方案。地铁 / 打车 / 步行都可以，支持多个备选。</li>
            ) : null}
          </ul>
          <TransportAddRow
            tripId={tripId}
            fromId={fromId}
            toId={toId}
            fromName={fromName}
            toName={toName}
            firstOption={options.length === 0}
            act={act}
          />
          <div className="t-transport-panel-foot">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>收起</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TransportOptionRow({
  tripId,
  option,
  preferred,
  pending,
  onSetPreferred,
  act,
}: {
  tripId: number;
  option: TransportLeg;
  preferred: boolean;
  pending: boolean;
  onSetPreferred: () => void;
  act: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const [mode, setMode] = useState(option.mode);
  const [duration, setDuration] = useState(option.duration);
  const [cost, setCost] = useState(option.cost);
  const [note, setNote] = useState(option.note);
  const dirty = mode !== option.mode || duration !== option.duration || cost !== option.cost || note !== option.note;
  return (
    <li className={`t-transport-option${preferred ? " is-preferred" : ""}`}>
      <div className="t-transport-option-head">
        <label className="t-transport-pref">
          <input
            type="radio"
            name={`transport-pref-${option.fromPlaceId}-${option.toPlaceId}`}
            checked={preferred}
            disabled={pending || preferred}
            onChange={onSetPreferred}
          />
          首选
        </label>
        <span className="t-transport-option-mode">{option.mode}</span>
        <button
          type="button"
          className="icon-btn"
          title="删除该方案"
          disabled={pending}
          onClick={() => { if (window.confirm("删除该交通方案？")) act(() => deleteTransportAction(option.id)); }}
        >
          🗑
        </button>
      </div>
      <div className="t-transport-fields">
        <input className="input" value={mode} onChange={(e) => setMode(e.target.value)} maxLength={40} placeholder="方式，如：地铁" aria-label={`交通方式（${option.id}）`} />
        <input className="input" value={duration} onChange={(e) => setDuration(e.target.value)} maxLength={40} placeholder="耗时" aria-label={`预计耗时（${option.id}）`} />
        <input className="input" value={cost} onChange={(e) => setCost(e.target.value)} maxLength={40} placeholder="¥" aria-label={`费用（${option.id}）`} />
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="备注：线路/出口等" aria-label={`交通备注（${option.id}）`} />
      </div>
      {dirty ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending || !mode.trim()}
          onClick={() => act(() => updateTransportAction(option.id, { mode, duration, cost, note }))}
        >
          保存修改
        </button>
      ) : null}
    </li>
  );
}

function TransportAddRow({
  tripId,
  fromId,
  toId,
  fromName,
  toName,
  firstOption,
  act,
}: {
  tripId: number;
  fromId: number;
  toId: number;
  fromName: string;
  toName: string;
  firstOption: boolean;
  act: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const [mode, setMode] = useState("");
  const [duration, setDuration] = useState("");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const [pendingAdd, startTransitionAdd] = useTransition();
  const ready = mode.trim() !== "" && !pendingAdd;
  return (
    <div className="t-transport-add">
      <p className="t-hint">新增方案：{fromName} → {toName}</p>
      <div className="t-transport-fields">
        <input className="input" value={mode} onChange={(e) => setMode(e.target.value)} maxLength={40} placeholder="方式，如：地铁 2 号线" aria-label="新方案交通方式" />
        <input className="input" value={duration} onChange={(e) => setDuration(e.target.value)} maxLength={40} placeholder="耗时" aria-label="新方案预计耗时" />
        <input className="input" value={cost} onChange={(e) => setCost(e.target.value)} maxLength={40} placeholder="¥" aria-label="新方案费用" />
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="备注：线路/出口等" aria-label="新方案交通备注" />
      </div>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!ready}
        onClick={() => startTransitionAdd(async () => {
          const r = await addTransportAction(tripId, fromId, toId, { mode, duration, cost, note, preferred: firstOption });
          if (r.ok) { setMode(""); setDuration(""); setCost(""); setNote(""); }
        })}
      >
        ＋ 添加方案
      </button>
    </div>
  );
}
