import { getFilmDb, readImage } from "@/lib/filmlog/store";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const parts = (await params).path;
  const headers = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "Cache-Control": "private, max-age=3600, no-transform" };
  if (!Array.isArray(parts) || parts.length !== 2 || !/^\d{1,12}$/.test(parts[0])) return new Response("Not Found", { status: 404, headers });
  const image = readImage(getFilmDb(), Number(parts[0]), parts[1]);
  if (!image) return new Response("Not Found", { status: 404, headers });
  return new Response(new Uint8Array(image.data), { headers: { ...headers, "Content-Type": image.mime } });
}
