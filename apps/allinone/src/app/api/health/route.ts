// 存活探针：compose healthcheck 依赖此路由。
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return new Response("ok", {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
