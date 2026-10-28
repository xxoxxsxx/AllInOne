"use client";

// 行程详情交互：Leaflet 示意地图（点击落点）、按天列表、拖拽排序、
// 地点编辑（备注/时间/花费/坐标）、链接（自动识别平台）与照片（浏览器端压缩上传）。
// 所有变更走 Server Actions；RSC 重验证后 props 更新，本地 state 跟随 props。

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { Map as LeafletMap, LayerGroup, Polyline, TileLayer } from "leaflet";
import "leaflet/dist/leaflet.css";

import type { Place, Trip } from "@/lib/travel/db";
import { platformById } from "@/lib/travel/platforms";

import {
  addDayAction,
  addLinkAction,
  addPlaceAction,
  deleteDayAction,
  deleteLinkAction,
  deletePhotoAction,
  deletePlaceAction,
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

async function compressToJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const MAX_EDGE = 1600;
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法处理图片");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片压缩失败"))), "image/jpeg", 0.82);
  });
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
  const [tile, setTile] = useState<"amap" | "osm">("amap");
  const [mapReady, setMapReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);

  // 全序编号：天顺序 → 天内顺序；待安排不编号。
  const { seqOf, orderedCoords } = (() => {
    const seq = new Map<number, number>();
    const coords: Array<{ lat: number; lng: number; color: string; seq: number }> = [];
    let n = 0;
    trip.days.forEach((day, di) => {
      day.places.forEach((p) => {
        n += 1;
        seq.set(p.id, n);
        if (p.lat !== null && p.lng !== null) coords.push({ lat: p.lat, lng: p.lng, color: dayColor(di), seq: n });
      });
    });
    return { seqOf: seq, orderedCoords: coords };
  })();
  const placeById = useMemo(() => {
    const m = new Map<number, Place>();
    for (const d of trip.days) for (const p of d.places) m.set(p.id, p);
    for (const p of trip.loose) m.set(p.id, p);
    return m;
  }, [trip]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setMsg(r.error ?? "操作失败");
    });
  };

  // —— 地图 ——
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const markersRef = useRef<LayerGroup | null>(null);
  const lineRef = useRef<Polyline | null>(null);
  const tileRef = useRef<TileLayer | null>(null);
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
      map.on("click", (e) => {
        const pid = pickingRef.current;
        if (pid == null) return;
        setPicking(null);
        setMsg(`已为地点设置坐标 ${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`);
        run(() => updatePlaceAction(pid, { lat: e.latlng.lat, lng: e.latlng.lng }));
      });
      setMapReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current = null;
      lineRef.current = null;
      tileRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 底图切换（高德无 key 国内友好 / OSM 通用）。
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    if (tileRef.current) map.removeLayer(tileRef.current);
    tileRef.current =
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
    tileRef.current.addTo(map);
  }, [tile, mapReady]);

  // 标注与路线重绘（数据或底图变化时）。
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
    for (const c of orderedCoords) {
      const isActive = editorPlaceId !== null && seqOf.get(editorPlaceId) === c.seq;
      const pickingHere = pickingRef.current !== null && seqOf.get(pickingRef.current) === c.seq;
      const icon = L.divIcon({
        className: "",
        html: `<div class="t-pin${isActive ? " t-pin-active" : ""}" style="--pin:${c.color}${pickingHere ? ";animation:t-pulse 1s infinite" : ""}"><span>${c.seq}</span></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      const marker = L.marker([c.lat, c.lng], { icon, title: `第 ${c.seq} 站` });
      marker.on("click", () => {
        const pid = [...seqOf.entries()].find(([, s]) => s === c.seq)?.[0];
        if (pid !== undefined) {
          setEditor({ mode: "edit", placeId: pid });
          document.getElementById(`place-${pid}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
      group.addLayer(marker);
    }
    if (orderedCoords.length >= 2) {
      lineRef.current = L.polyline(
        orderedCoords.map((c) => [c.lat, c.lng] as [number, number]),
        { color: "#2563eb", weight: 2, opacity: 0.65, dashArray: "6 8" },
      ).addTo(map);
    }
  }, [trip, tile, mapReady, editor, picking, orderedCoords, seqOf, placeById]);

  const fitAll = () => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || orderedCoords.length === 0) return;
    map.fitBounds(L.latLngBounds(orderedCoords.map((c) => [c.lat, c.lng] as [number, number])).pad(0.2));
  };
  useEffect(() => {
    if (mapReady) fitAll();
    // 仅在打开行程 / 地图就绪时自动全览，后续编辑不打断视野。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id, mapReady]);

  // —— 列表交互 ——
  const dragFrom = useRef<number | null>(null);

  const onDropDay = (dayId: number, toIndex: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === toIndex) return;
    const day = trip.days.find((d) => d.id === dayId);
    if (!day) return;
    const ids = day.places.map((p) => p.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(toIndex, 0, moved);
    // 本地立即重排，随后 RSC 校对。
    setTrip((t) => ({
      ...t,
      days: t.days.map((d) =>
        d.id === dayId ? { ...d, places: ids.map((id) => d.places.find((p) => p.id === id)!) } : d,
      ),
    }));
    run(() => reorderPlacesAction(dayId, ids));
  };

  const editingPlace = editor?.mode === "edit" ? placeById.get(editor.placeId) ?? null : null;
  const pickingPlace = picking !== null ? placeById.get(picking) ?? null : null;

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
                    {trip.days.length} 天 · {seqOf.size} 个地点
                    {trip.startDate ? ` · ${trip.startDate} 出发` : ""}
                  </p>
                  {trip.description ? <p className="trip-head-desc">{trip.description}</p> : null}
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditingHeader(true)}>编辑信息</button>
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
              <ol className="t-places">
                {day.places.map((p, pi) => (
                  <li
                    key={p.id}
                    id={`place-${p.id}`}
                    className={`t-place${editor?.mode === "edit" && editor.placeId === p.id ? " t-place-active" : ""}`}
                    draggable
                    onDragStart={() => (dragFrom.current = pi)}
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
                    <span className="t-place-grip" title="拖拽排序">⋮⋮</span>
                  </li>
                ))}
                {day.places.length === 0 ? <li className="t-place-empty">这一天还没有安排，点下面添加地点。</li> : null}
              </ol>
              <button className="btn btn-ghost btn-sm t-day-add" onClick={() => setEditor({ mode: "add", dayId: day.id })}>＋ 添加地点</button>
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
                      <span className="t-place-name">{p.name}</span>
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
          trip={trip}
          editor={editor}
          place={editingPlace}
          pending={pending}
          uploading={uploading}
          setMsg={setMsg}
          onClose={() => setEditor(null)}
          // 点选坐标需要看到地图：关闭弹层，进入点选模式（横幅提示，可取消）。
          onPicking={(placeId) => {
            setEditor(null);
            setPicking(placeId);
          }}
          onMoveToDay={(placeId, dayId) => run(() => movePlaceAction(placeId, dayId))}
          run={run}
          startUpload={async (placeId, files) => {
            const fd = new FormData();
            for (const f of files) fd.append("files", f);
            setUploading(true);
            try {
              const r = await uploadPhotosAction(placeId, fd);
              if (!r.ok) setMsg(r.error ?? "上传失败");
              else setMsg(`已上传 ${r.count} 张照片`);
            } catch (e) {
              setMsg(e instanceof Error ? e.message : "上传失败");
            } finally {
              setUploading(false);
            }
          }}
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

function PlaceEditor({
  trip,
  editor,
  place,
  pending,
  uploading,
  setMsg,
  onClose,
  onPicking,
  onMoveToDay,
  run,
  startUpload,
}: {
  trip: Trip;
  editor: Exclude<Editor, null>;
  place: Place | null;
  pending: boolean;
  uploading: boolean;
  setMsg: (s: string | null) => void;
  onClose: () => void;
  onPicking: (placeId: number) => void;
  onMoveToDay: (placeId: number, dayId: number | null) => void;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
  startUpload: (placeId: number, files: File[]) => Promise<void>;
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
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  const save = () => {
    const n = name.trim();
    if (!n) {
      setMsg("地点名称不能为空");
      return;
    }
    if (isAdd) {
      run(async () => {
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
        onClose();
        return { ok: true };
      });
    } else if (place) {
      run(async () => {
        const r = await updatePlaceAction(place.id, { name, timeLabel, cost, address, note });
        if (r.ok) onClose();
        return r;
      });
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
                  <button className="btn btn-secondary btn-sm" onClick={() => onPicking(place.id)}>📍 在地图上点选</button>
                  {place.lat !== null ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => run(() => updatePlaceAction(place.id, { lat: null, lng: null }))}>清除</button>
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
                          onClick={() => {
                            if (window.confirm("删除该链接？")) run(() => deleteLinkAction(l.id));
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
                    disabled={pending || !linkUrl.trim()}
                    onClick={() => {
                      const pid = place.id;
                      const url = linkUrl;
                      const title = linkTitle;
                      run(async () => {
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
                <h3>照片{place.photos.length > 0 ? `（${place.photos.length}）` : ""}</h3>
                <div className="t-photos">
                  {place.photos.map((ph) => (
                    <div key={ph.id} className="t-photo">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/travel/photos/${ph.file}`} alt="" loading="lazy" />
                      <button
                        className="t-photo-del"
                        title="删除照片"
                        onClick={() => {
                          if (window.confirm("删除该照片？")) run(() => deletePhotoAction(ph.id));
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button className="t-photo-add" disabled={uploading} onClick={() => photoInputRef.current?.click()}>
                    {uploading ? "上传中…" : "＋ 添加"}
                  </button>
                </div>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={async (e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    if (files.length === 0) return;
                    try {
                      const blobs = await Promise.all(files.map((f) => compressToJpeg(f)));
                      const jpegs = blobs.map((b, i) => new File([b], `photo-${i}.jpg`, { type: "image/jpeg" }));
                      await startUpload(place.id, jpegs);
                    } catch (err) {
                      setMsg(err instanceof Error ? err.message : "图片处理失败");
                    }
                  }}
                />
                <p className="t-hint">上传前会在浏览器压缩到长边 1600px，省流量也不占 NAS 空间。</p>
              </section>

              <div className="t-danger-zone">
                <button
                  className="btn btn-danger btn-sm"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(`删除地点「${place.name}」及其链接与照片？`)) {
                      const pid = place.id;
                      run(async () => {
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
          <button className="btn btn-primary" disabled={pending} onClick={save}>{isAdd ? "添加" : "保存"}</button>
        </footer>
      </div>
    </div>
  );
}
