// 单应用内的工具健康状态（v2：所有工具同进程，改为内省式检查）。
// - ledger：SQLite 文件存在且为合法 SQLite；
// - stocks：同上（调度器与 Web 同进程，进程存活即可用）；
// - framelab：public/framelab/index.html 存在；
// - external 工具：未监测。
// 结果内存缓存 30 秒；任何失败不抛错，返回 unknown/未监测。
import fs from "node:fs";
import path from "node:path";
import type { HealthState, ToolStatus } from "./types";
import { configDir } from "./tools";
import { dataDir } from "./data-dir";

const CHECK_INTERVAL_MS = 30_000;

interface CacheEntry {
  state: HealthState;
  reason?: ToolStatus["reason"];
  checkedAt: string;
}

const cache = new Map<string, CacheEntry>();

function sqliteOk(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return buf.toString("utf8").startsWith("SQLite format 3");
  } catch {
    return false;
  }
}

function checkTool(id: string): ToolStatus {
  const now = new Date().toISOString();
  const data = dataDir();
  let state: HealthState;
  let reason: ToolStatus["reason"];
  if (id === "cdk-ledger") {
    state = sqliteOk(path.join(data, "cdk", "cdk.db")) ? "ok" : "unknown";
    reason = state === "ok" ? undefined : "network";
  } else if (id === "tickersentry") {
    state = sqliteOk(path.join(data, "tickersentry", "ticker.db")) ? "ok" : "unknown";
    reason = state === "ok" ? undefined : "network";
  } else if (id === "framelab") {
    const p = path.join(process.cwd(), "public", "framelab", "index.html");
    state = fs.existsSync(p) ? "ok" : "unknown";
    reason = state === "ok" ? undefined : "status";
  } else {
    state = "unmonitored";
    reason = "no-entry";
  }
  return { id, state, checkedAt: state === "unmonitored" ? null : now, reason };
}

export async function getStatuses(): Promise<ToolStatus[]> {
  // 从工具清单拿 id 集合（不经 tools.ts，避免与页面模块循环引用）。
  const toolsFile = path.join(configDir(), "tools.json");
  let ids: string[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(toolsFile, "utf8"));
    if (Array.isArray(parsed)) {
      ids = parsed
        .filter((t): t is { id: string } => typeof t === "object" && t !== null && typeof (t as { id?: unknown }).id === "string")
        .map((t) => t.id);
    }
  } catch {
    return [];
  }

  const out: ToolStatus[] = [];
  for (const id of ids) {
    const cached = cache.get(id);
    if (
      cached &&
      cached.state !== "unknown" &&
      Date.now() - new Date(cached.checkedAt).getTime() < CHECK_INTERVAL_MS
    ) {
      out.push({ id, state: cached.state, checkedAt: cached.checkedAt, reason: cached.reason });
      continue;
    }
    const result = checkTool(id);
    cache.set(id, {
      state: result.state,
      reason: result.reason,
      checkedAt: result.checkedAt ?? new Date().toISOString(),
    });
    out.push(result);
  }
  return out;
}
