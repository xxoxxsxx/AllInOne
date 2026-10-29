"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { Trip } from "@/lib/travel/db";
import type { SearchPlace } from "@/lib/travel/search-types";
import { readSearchResponse } from "@/lib/travel/search-response";
import { addPlaceAction } from "./actions";
import "./place-search.css";

export function PlaceSearch({ trip, configured, onLocate, onAdded, onSourceChange }: {
  trip: Trip;
  configured: boolean;
  onSourceChange: (source: "amap" | "global") => void;
  onLocate: (place: SearchPlace) => void;
  onAdded: (place: SearchPlace) => void;
}) {
  const router = useRouter();
  const id = useId();
  const [source, setSource] = useState<"amap" | "global">(configured ? "amap" : "global");
  const [attribution, setAttribution] = useState("");
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("");
  const [dayId, setDayId] = useState(trip.days[0] ? String(trip.days[0].id) : "");
  const [places, setPlaces] = useState<SearchPlace[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);
  const addLock = useRef(false);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (dayId && !trip.days.some(day => String(day.id) === dayId)) setDayId("");
  }, [dayId, trip.days]);
  useEffect(() => {
    if (!configured && source === "amap") { sequence.current += 1; request.current?.abort(); setLoading(false); setPlaces([]); }
  }, [configured, source]);

  // Editing search text immediately invalidates the preceding request/results.
  // No autocomplete requests are sent: only an explicit submit reaches the API.
  const changeInput = (kind: "query" | "city", value: string) => {
    sequence.current += 1;
    request.current?.abort();
    setLoading(false); setPlaces([]); setSearched(false); setError(""); setNotice("");
    if (kind === "query") setQuery(value); else setCity(value);
  };
  const search = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if ((source === "amap" && !configured) || addLock.current) return;
    const q = query.trim();
    if (!q) { setError("请输入景点、店名或地址"); return; }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++sequence.current;
    setLoading(true); setSearched(false); setPlaces([]); setError(""); setNotice("");
    try {
      const params = new URLSearchParams({ q, source });
      if (city.trim()) params.set("city", city.trim());
      const response = await fetch(`/api/travel/search?${params}`, {
        signal: controller.signal, cache: "no-store", headers: { Accept: "application/json" },
      });
      const data: unknown = await response.json();
      if (!mounted.current || version !== sequence.current || controller.signal.aborted) return;
      const result = readSearchResponse(response.ok, data);
      setPlaces(result.places); setAttribution(result.attribution); setSearched(true);
    } catch (reason) {
      if (!mounted.current || version !== sequence.current || controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "网络请求失败，请稍后重试");
    } finally {
      if (mounted.current && version === sequence.current) setLoading(false);
    }
  };
  const add = async (place: SearchPlace) => {
    if (addLock.current) return;
    addLock.current = true; setAddingId(place.id); setError(""); setNotice("");
    const targetId = dayId ? Number(dayId) : null;
    const targetName = trip.days.find(day => day.id === targetId)?.title ?? "待安排";
    try {
      const result = await addPlaceAction(trip.id, targetId, place.name, { address: place.address, lat: place.lat, lng: place.lng });
      if (!mounted.current) return;
      if (!result.ok) { setError(result.error || "添加失败，请重试"); return; }
      setNotice(`已将「${place.name}」加入「${targetName}」`);
      onAdded(place);
      router.refresh();
    } catch {
      if (mounted.current) setError("添加请求未完成。请先核对行程列表是否已添加，再重试，避免重复。");
    } finally {
      addLock.current = false;
      if (mounted.current) setAddingId(null);
    }
  };

  const available = source === "global" || configured;
  return <section className="travel-search" aria-label="地点搜索">
    <div className="travel-search-heading"><h2>搜索地点</h2><Link href="/travel/settings">搜索设置</Link></div>
    <div className="travel-search-sources" role="group" aria-label="地点搜索来源">
      {(["amap", "global"] as const).map(value => <button key={value} type="button"
        aria-pressed={source === value} disabled={addingId !== null}
        onClick={() => {
          sequence.current += 1; request.current?.abort();
          setSource(value); setPlaces([]); setSearched(false); setError(""); setNotice(""); setLoading(false);
          onSourceChange(value);
        }}>{value === "amap" ? "高德（国内）" : "全球（国外地址）"}</button>)}
    </div>
    {!available && <div className="travel-search-unconfigured">
      <span>国内搜索需要配置高德 Web 服务 Key；全球搜索无需 Key。</span>
      <Link href="/travel/settings">设置高德搜索 →</Link>
    </div>}
    <form className="travel-search-form" onSubmit={search} aria-busy={loading}>
      <label htmlFor={`${id}-query`}>景点、店名或地址
        <input id={`${id}-query`} value={query} maxLength={80} required disabled={!available || addingId !== null}
          placeholder={source === "global" ? "例如：Eiffel Tower 或 5 Avenue Anatole France" : "例如：太平山顶、星光大道"} autoComplete="off" onChange={event => changeInput("query", event.target.value)} />
      </label>
      <label htmlFor={`${id}-city`}>城市（可选）
        <input id={`${id}-city`} value={city} maxLength={40} disabled={!available || addingId !== null}
          placeholder={source === "global" ? "例如：Paris, France" : "例如：香港"} autoComplete="off" onChange={event => changeInput("city", event.target.value)} />
      </label>
      <button type="submit" disabled={!available || loading || addingId !== null || query.trim().length < 2}>{loading ? "搜索中…" : "搜索"}</button>
    </form>
    <p className="travel-search-hint">{source === "global" ? "全球搜索由 Photon / OpenStreetMap 提供，无需 Key；可用英文或当地语言并填写城市/国家，每秒最多一次。" : "国内搜索由高德地图提供。"} 选择候选地点后可定位，或加入指定天。</p>
    {error && <p className="travel-search-error" role="alert">{error}</p>}
    {notice && <p className="travel-search-notice" role="status">{notice}</p>}
    {places.length > 0 && <>
      <label className="travel-search-day" htmlFor={`${id}-day`}>加入到
        <select id={`${id}-day`} value={dayId} disabled={addingId !== null} onChange={event => setDayId(event.target.value)}>
          {trip.days.map((day, index) => <option value={day.id} key={day.id}>Day {index + 1} · {day.title}</option>)}
          <option value="">待安排</option>
        </select>
      </label>
      <ul className="travel-search-results">
        {places.map(place => <li key={place.id}>
          <div className="travel-search-place"><h3>{place.name}</h3><p>{place.address || "暂无详细地址"}</p></div>
          <div className="travel-search-result-actions">
            <button type="button" disabled={addingId !== null} onClick={() => onLocate(place)} aria-label={`定位 ${place.name}`}>定位</button>
            <button type="button" className="travel-search-add" disabled={addingId !== null} onClick={() => void add(place)}
              aria-label={`加入行程 ${place.name}`}>{addingId === place.id ? "添加中…" : "加入行程"}</button>
          </div>
        </li>)}
      </ul>
      <p className="travel-search-attribution">{attribution}</p>
    </>}
    {searched && places.length === 0 && <p className="travel-search-empty" role="status">没有找到地点。试试英文或当地名称、补充城市/国家，或在地图上手动点选。</p>}
  </section>;
}
