import { NextResponse } from "next/server";

import { getDB } from "@/modules/stocks/store";
import { exportConfig, BACKUP_LIMIT } from "@/modules/stocks/backup";

export const dynamic = "force-dynamic";

// POST /stocks/settings/backup：下载 JSON 配置备份（config_backup.go downloadConfig 语义）。
export async function POST(): Promise<NextResponse> {
  const db = getDB();
  const b = exportConfig(db);
  const data = JSON.stringify(b, null, 2);
  if (data.length > BACKUP_LIMIT) {
    return NextResponse.json({ error: "配置超过 2 MiB，请使用 SQLite 完整备份" }, { status: 400 });
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="tickersentry-config-${stamp}.json"`,
    },
  });
}
