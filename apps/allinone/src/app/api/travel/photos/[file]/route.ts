// 照片文件服务：GET /api/travel/photos/<file>
// 文件名白名单校验（随机 token + 扩展名），命中后长缓存（文件不可变，删除即 404）。

import { contentTypeOf, readPhotoFile } from "@/lib/travel/photos";

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const data = readPhotoFile(file);
  if (!data) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": contentTypeOf(file),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
