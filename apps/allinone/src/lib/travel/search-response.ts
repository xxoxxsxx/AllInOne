import type { SearchPlace, SearchResponse } from "./search-types";

function isPlace(value: unknown): value is SearchPlace {
  if (!value || typeof value !== "object") return false;
  const place = value as Partial<SearchPlace>;
  return typeof place.id === "string" && typeof place.name === "string" &&
    typeof place.address === "string" && typeof place.lat === "number" &&
    typeof place.lng === "number" && Number.isFinite(place.lat) && Number.isFinite(place.lng) &&
    Math.abs(place.lat) <= 90 && Math.abs(place.lng) <= 180;
}

// The API uses HTTP status plus { places, attribution }, not an `ok` JSON flag.
// Keep this boundary shared with regression tests so successful API payloads
// are exercised by the same parser the browser uses.
export function readSearchResponse(httpOk: boolean, value: unknown): SearchResponse {
  const result = value && typeof value === "object"
    ? value as Partial<SearchResponse> & { error?: unknown } : null;
  if (!httpOk) {
    throw new Error(typeof result?.error === "string" ? result.error : "地点搜索失败，请稍后重试");
  }
  if (!result || !Array.isArray(result.places) || !result.places.every(isPlace) ||
      typeof result.attribution !== "string") {
    throw new Error("搜索服务返回了无效的地点数据，请重试");
  }
  return { places: result.places, attribution: result.attribution };
}
