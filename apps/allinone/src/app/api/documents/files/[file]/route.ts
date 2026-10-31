// 只提供仍关联证件的附件；删除后即使磁盘清理失败也不再可访问。
import { getDocumentsDB } from "@/lib/documents/db";
import { contentTypeOf, isValidDocumentFilename, readDocumentFile } from "@/lib/documents/files";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
  };
  if (!isValidDocumentFilename(file)) return new Response("Not Found", { status: 404, headers });
  const row = getDocumentsDB().prepare("SELECT name FROM document_files WHERE file=?").get(file) as { name: string } | undefined;
  if (!row) return new Response("Not Found", { status: 404, headers });
  const data = readDocumentFile(file);
  if (!data) return new Response("Not Found", { status: 404, headers });
  const download = new URL(req.url).searchParams.get("download") === "1";
  const name = encodeURIComponent(row.name || file).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(new Uint8Array(data), {
    headers: {
      ...headers,
      "Content-Type": contentTypeOf(file),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
    },
  });
}
