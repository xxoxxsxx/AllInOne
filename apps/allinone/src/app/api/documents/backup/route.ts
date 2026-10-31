// GET /api/documents/backup：一键导出全部证件数据 + 附件原始文件的 ZIP 备份。
// 可靠性优先：任何附件缺失都直接 500（附缺失清单），绝不返回不完整备份；
// 其他任何构建错误同样 500 + JSON 错误消息。响应禁缓存 + nosniff。

import { getDocumentsDB } from "@/lib/documents/db";
import { readDocumentFile } from "@/lib/documents/files";
import { backupFileName, buildDocumentBackup } from "@/lib/documents/backup";

export const dynamic = "force-dynamic";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(): Promise<Response> {
  try {
    const result = buildDocumentBackup(getDocumentsDB(), readDocumentFile);
    if (result.stats.missing.length > 0) {
      // 附件在磁盘上缺失：数据库记录与存储不一致，必须让导出失败而非给出不完整备份。
      return Response.json(
        {
          error: `备份失败：${result.stats.missing.length} 个附件文件缺失（${result.stats.missing.join("、")}），已拒绝导出不完整备份`,
          missing: result.stats.missing,
        },
        { status: 500, headers: BASE_HEADERS },
      );
    }
    const filename = backupFileName(new Date(result.manifest.generated_at));
    return new Response(new Uint8Array(result.zip), {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: `备份失败：${error instanceof Error ? error.message : String(error)}` },
      { status: 500, headers: BASE_HEADERS },
    );
  }
}
