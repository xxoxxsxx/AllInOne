// Global place search through Photon. Only explicit user searches reach this
// service: no autocomplete, bulk lookup or background prefetch.
import { wgs84ToGcj02 } from "./coordinates";
import type { SearchPlace } from "./search-types";
import type { SearchResult } from "./search";

const PHOTON_URL = "https://photon.komoot.io/api/";
export const GLOBAL_SEARCH_ATTRIBUTION = "地点数据 © OpenStreetMap contributors · Photon";
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 100;
const REQUEST_INTERVAL_MS = 1000;
const RESULT_LIMIT = 10;

type CacheEntry = { at: number; places: SearchPlace[] };

function result(status: number, places: SearchPlace[] = [], error?: string): SearchResult {
  return { status, places, attribution: GLOBAL_SEARCH_ATTRIBUTION, ...(error ? { error } : {}) };
}

function field(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Clean public Photon GeoJSON and convert WGS coordinates into project storage. */
export function parsePhotonPlaces(payload: unknown): SearchPlace[] | null {
  if (!payload || typeof payload !== "object") return null;
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features)) return null;
  const places: SearchPlace[] = [];
  const seen = new Set<string>();
  // The endpoint is requested with limit=10. Bound malformed/oversized payload work.
  for (const feature of features.slice(0, 100)) {
    if (!feature || typeof feature !== "object") continue;
    const { properties, geometry } = feature as { properties?: unknown; geometry?: unknown };
    if (!properties || typeof properties !== "object" || !geometry || typeof geometry !== "object") continue;
    const props = properties as Record<string, unknown>;
    const geom = geometry as { type?: unknown; coordinates?: unknown };
    if (geom.type !== "Point" || !Array.isArray(geom.coordinates) || geom.coordinates.length !== 2) continue;
    const [lng, lat] = geom.coordinates;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) ||
        Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const type = field(props.osm_type).toUpperCase();
    if (!/^[NWR]$/.test(type)) continue;
    const osmId = typeof props.osm_id === "number"
      ? (Number.isSafeInteger(props.osm_id) && props.osm_id > 0 ? String(props.osm_id) : "")
      : (typeof props.osm_id === "string" && /^[1-9][0-9]{0,19}$/.test(props.osm_id) ? props.osm_id : "");
    const name = field(props.name).slice(0, 80);
    if (!osmId || !name) continue;
    const id = `${type}${osmId}`;
    if (seen.has(id)) continue;
    const street = [field(props.housenumber), field(props.street)].filter(Boolean).join(" ");
    const parts = [street, field(props.district), field(props.city), field(props.state), field(props.postcode), field(props.country)];
    const address = [...new Set(parts.filter(Boolean))].join(", ").slice(0, 200);
    const stored = wgs84ToGcj02({ lat, lng });
    places.push({ id, name, address, lat: stored.lat, lng: stored.lng });
    seen.add(id);
    if (places.length === RESULT_LIMIT) break;
  }
  return places;
}

/** Per-instance state makes tests independent; production uses one shared singleton.
 * The time slot is reserved synchronously before any await: simultaneous misses
 * cannot all pass the limit, and rejected requests never consume a Photon call. */
export function createGlobalSearch(deps: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
} = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const cache = new Map<string, CacheEntry>();
  let lastRequestAt = -Infinity;

  return async function search(rawQuery: string, rawCity: string): Promise<SearchResult> {
    if (typeof rawQuery !== "string" || typeof rawCity !== "string") return result(400, [], "搜索内容无效");
    const query = rawQuery.trim(), city = rawCity.trim();
    if (query.length < 2 || query.length > 80) return result(400, [], "请输入 2–80 个字符进行搜索");
    if (city.length > 40) return result(400, [], "城市名过长");
    if (/[\u0000-\u001f\u007f]/.test(query + city)) return result(400, [], "搜索内容包含无效字符");
    const key = `${query}\u0000${city}`;
    const time = now();
    const hit = cache.get(key);
    if (hit && time - hit.at >= 0 && time - hit.at < CACHE_TTL_MS) {
      cache.delete(key); cache.set(key, hit);
      return result(200, hit.places.map(place => ({ ...place })));
    }
    cache.delete(key);
    if (time - lastRequestAt < REQUEST_INTERVAL_MS) return result(429, [], "全球搜索请求较频繁，请间隔 1 秒后重试");
    lastRequestAt = time;

    const url = new URL(PHOTON_URL);
    url.searchParams.set("q", [query, city].filter(Boolean).join(" "));
    url.searchParams.set("limit", String(RESULT_LIMIT));
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A race also bounds response JSON parsing and clients that ignore abort.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true; controller.abort(); reject(new Error("timeout"));
      }, timeoutMs);
    });
    try {
      const request = (async () => {
        const response = await fetchImpl(url, {
          signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "AllInOne-Travel/1.0" },
          redirect: "error",
        });
        if (response.status === 429) return result(429, [], "全球搜索服务繁忙，请稍后再试");
        if (!response.ok) return result(502, [], "全球搜索服务暂时不可用，请稍后再试");
        const places = parsePhotonPlaces(await response.json());
        if (places === null) return result(502, [], "全球搜索服务返回异常，请稍后再试");
        return result(200, places);
      })();
      const response = await Promise.race([request, timeout]);
      if (response.status === 200) {
        cache.set(key, { at: now(), places: response.places.map(place => ({ ...place })) });
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      }
      return response;
    } catch {
      return timedOut ? result(504, [], "全球搜索超时，请稍后再试")
        : result(502, [], "全球搜索服务暂时不可用，请稍后再试");
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export const searchGlobalPlaces = createGlobalSearch();
