import { getStatuses } from "@/lib/health";

export const dynamic = "force-dynamic";

// 工具状态 API：仅返回状态与检查时间，不回显内部上游地址（PRD §7.2）。
export async function GET() {
  try {
    const tools = await getStatuses();
    return Response.json(
      { checkedAt: new Date().toISOString(), tools },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ checkedAt: new Date().toISOString(), tools: [] }, { status: 200 });
  }
}
