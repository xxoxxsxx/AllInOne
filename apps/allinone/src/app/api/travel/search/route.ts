import { AMAP_ATTRIBUTION, searchPlaces } from "@/lib/travel/search";

export const dynamic = "force-dynamic";

// GET /api/travel/search?q=关键词&city=城市（可选）
// 成功：{ places: SearchPlace[], attribution }；失败：{ error }（不含任何 URL/Key/上游原文）。
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const city = url.searchParams.get("city") ?? "";
  const result = await searchPlaces(query, city);
  const { status, error } = result;
  if (error) return Response.json({ error }, { status });
  return Response.json({ places: result.places, attribution: result.attribution }, { status });
}
