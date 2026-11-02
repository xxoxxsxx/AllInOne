// 提醒图片文件服务：GET /reminders/attachments/<reminderId>/<stored_name>
// 安全：段数固定为 2、reminderId 必须为纯数字、文件名白名单（随机 token + jpg/png/webp），
// 且 resolve 后必须仍在附件根目录内（防路径穿越）。
// 缓存：文件内容不可变（删除即 404），private + no-transform（附件属私人数据，不进共享缓存）。

import { contentTypeOfImage, readReminderAttachment } from "@/lib/reminders/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "private, max-age=3600, no-transform",
  } as const;
  if (!Array.isArray(path) || path.length !== 2) {
    return new Response("Not Found", { status: 404, headers });
  }
  const [reminderIdRaw, storedName] = path;
  if (!/^\d{1,12}$/.test(reminderIdRaw)) {
    return new Response("Not Found", { status: 404, headers });
  }
  const data = readReminderAttachment(Number(reminderIdRaw), storedName);
  if (!data) {
    return new Response("Not Found", { status: 404, headers });
  }
  return new Response(new Uint8Array(data), {
    headers: { ...headers, "Content-Type": contentTypeOfImage(storedName) },
  });
}
