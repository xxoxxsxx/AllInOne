import { AMAP_ATTRIBUTION, searchPlaces } from "@/lib/travel/search";
import { searchGlobalPlaces } from "@/lib/travel/global-search";

export const dynamic = "force-dynamic";

// GET /api/travel/search?q=关键词&city=城市（可选）&source=amap|global（可选，默认 amap）
// 成功：{ places: SearchPlace[], attribution }；失败：{ error }（不含任何 URL/Key/上游原文）。
// Photon（全球）是公共无 Key 服务：仅主动搜索触发、应用级 1s 间隔拒绝并发风暴。
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const city = url.searchParams.get("city") ?? "";
  const source = url.searchParams.get("source") ?? "amap";
  let result;
  if (source === "global") result = await searchGlobalPlaces(query, city);
  else if (source === "amap") result = await searchPlaces(query, city);
  else return Response.json({ error: "未知的搜索来源" }, { status: 400 });
  const { status, error } = result;
  if (error) return Response.json({ error }, { status });
  return Response.json({ places: result.places, attribution: result.attribution }, { status });
}
