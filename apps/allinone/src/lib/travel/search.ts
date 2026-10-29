// 高德地点搜索：仅用户主动提交时调用；Key 存服务端数据库，不回传页面。
// 遵守上游约束（cache 5min、>=500ms 间隔、错误脱敏不回显 URL/Key）。

import { getAmapKey, getTravelDB } from "./db";
import type { SearchPlace } from "./search-types";

const AMAP_PLACE_TEXT_URL = "https://restapi.amap.com/v3/place/text";
const AMAP_ATTRIBUTION = "地点数据 © 高德地图";
const SEARCH_TIMEOUT_MS = 8000;
const SEARCH_MIN_INTERVAL_MS = 500;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 100;
const MAX_PAGE_SIZE = 10;

export type SearchResponse = { places: SearchPlace[]; attribution: string };
export type SearchResult = SearchResponse & { error?: string; status: number };

type CacheEntry = { at: number; response: SearchResponse };

const cache = new Map<string, CacheEntry>();
let lastRequestAt = 0;

function throttle(nowMs: number): number {
  const elapsed = nowMs - lastRequestAt;
  if (elapsed >= SEARCH_MIN_INTERVAL_MS) {
    lastRequestAt = nowMs;
    return 0;
  }
  return SEARCH_MIN_INTERVAL_MS - elapsed;
}

function cacheKey(query: string, city: string): string {
  return `${query}\u0000${city}`;
}

function readCache(key: string, nowMs: number): SearchResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (nowMs - entry.at > SEARCH_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // LRU 语义：命中移到末尾（Map 保序）。
  cache.delete(key);
  cache.set(key, entry);
  return entry.response;
}

function writeCache(key: string, response: SearchResponse, nowMs: number): void {
  cache.set(key, { at: nowMs, response });
  while (cache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Injectable search core; production wires the real fetch, DB key and clock. */
export function createAmapSearch(deps: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  getKey?: () => string;
  sleep?: (ms: number) => Promise<void>;
}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const getKey = deps.getKey ?? (() => getAmapKey(getTravelDB()));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  return async function searchPlaces(rawQuery: string, rawCity: string): Promise<SearchResult> {
    const query = rawQuery.trim();
    const city = rawCity.trim();
    if (query.length < 2 || query.length > 80) return { places: [], attribution: AMAP_ATTRIBUTION, status: 400, error: "请输入 2–80 个字符进行搜索" };
    if (city.length > 40) return { places: [], attribution: AMAP_ATTRIBUTION, status: 400, error: "城市名过长" };

    const key = cacheKey(query, city);
    const hit = readCache(key, now());
    if (hit) return { ...hit, status: 200 };

    const amapKey = getKey().trim();
    if (!amapKey) return { places: [], attribution: AMAP_ATTRIBUTION, status: 400, error: "尚未配置高德 Web 服务 Key，请在设置中填写" };
    if (!/^[a-f0-9]{32}$/i.test(amapKey)) return { places: [], attribution: AMAP_ATTRIBUTION, status: 400, error: "高德 Key 格式无效，请在设置中重新保存 32 位十六进制 Key" };

    const wait = throttle(now());
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();

    const url = new URL(AMAP_PLACE_TEXT_URL);
    url.searchParams.set("key", amapKey);
    url.searchParams.set("keywords", query);
    url.searchParams.set("city", city);
    url.searchParams.set("citylimit", city ? "true" : "false");
    url.searchParams.set("offset", String(MAX_PAGE_SIZE));
    url.searchParams.set("page", "1");
    url.searchParams.set("extensions", "base");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    let payload: unknown;
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.status === 429) return { places: [], attribution: AMAP_ATTRIBUTION, status: 429, error: "搜索太频繁，请稍后再试" };
      if (!response.ok) return { places: [], attribution: AMAP_ATTRIBUTION, status: 502, error: "搜索服务暂时不可用，请稍后再试" };
      payload = await response.json();
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      return { places: [], attribution: AMAP_ATTRIBUTION, status: aborted ? 504 : 502, error: aborted ? "搜索超时，请稍后再试" : "搜索服务暂时不可用，请稍后再试" };
    } finally {
      clearTimeout(timer);
    }

    const parsed = parseAmapPlaceText(payload);
    if (!parsed.ok) {
      const status = parsed.kind === "quota" ? 429 : parsed.kind === "key" ? 400 : 502;
      return { places: [], attribution: AMAP_ATTRIBUTION, status, error: parsed.error };
    }
    const response: SearchResponse = { places: parsed.places, attribution: AMAP_ATTRIBUTION };
    writeCache(key, response, now());
    return { ...response, status: 200 };
  };
}

type ParseFailure = { ok: false; error: string; kind: "key" | "quota" | "transient" };
type Parsed = { ok: true; places: SearchPlace[] } | ParseFailure;

/** Lenient on shape, strict on values; never surfaces upstream error strings. */
export function parseAmapPlaceText(payload: unknown): Parsed {
  if (typeof payload !== "object" || payload === null) return { ok: false, error: "搜索服务返回异常，请稍后再试", kind: "transient" };
  const record = payload as { status?: unknown; info?: unknown; infocode?: unknown; pois?: unknown };
  const status = String(record.status);
  const info = typeof record.info === "string" ? record.info : "";
  const infocode = String(record.infocode ?? "");
  if (status !== "1") {
    // 高德错误码分类：Key/权限类（用户配置问题）与配额类（用量超限）都有明确提示。
    if (infocode === "10003" || infocode === "10044" || infocode === "10045" || /LIMIT/i.test(info)) {
      return { ok: false, error: "高德搜索配额已用尽或超频，请明天再试或检查账号配额", kind: "quota" };
    }
    if (/^(10001|10002|10004|10005|10006|10008|10009|10010|10011|10013|10014|10020|10021|10026|10027)/.test(infocode)) {
      return { ok: false, error: "高德 Key 无效或未开通搜索权限，请检查设置中的 Key", kind: "key" };
    }
    return { ok: false, error: "搜索服务暂时不可用，请稍后再试", kind: "transient" };
  }
  if (!Array.isArray(record.pois)) return { ok: false, error: "搜索服务返回异常，请稍后再试", kind: "transient" };
  const places: SearchPlace[] = [];
  for (const raw of record.pois.slice(0, MAX_PAGE_SIZE)) {
    if (typeof raw !== "object" || raw === null) continue;
    const poi = raw as { id?: unknown; name?: unknown; address?: unknown; location?: unknown };
    const id = typeof poi.id === "string" && /^[a-z0-9]+$/i.test(poi.id) ? poi.id : "";
    const name = typeof poi.name === "string" ? poi.name.trim() : "";
    const address = typeof poi.address === "string" ? poi.address.trim() : Array.isArray(poi.address) ? "" : "";
    const location = typeof poi.location === "string" ? poi.location.split(",") : [];
    const lng = Number(location[0]);
    const lat = Number(location[1]);
    if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || lng === 0 || lat === 0) continue;
    places.push({ id, name, address: address.slice(0, 200), lat, lng });
  }
  return { ok: true, places };
}

/** Production singleton: real fetch + server-stored key. */
export const searchPlaces = createAmapSearch({});
export { AMAP_ATTRIBUTION };
