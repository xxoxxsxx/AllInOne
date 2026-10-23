// 服务端健康检查（PRD §7.1/§7.2）。
// - 检查目标只来自部署配置 health.json（gitignore，仅提交 example）；
// - 30 秒缓存、单次 3 秒超时、并发上限 4；
// - 连续 2 次失败才判定“暂不可用”，单次失败保留前次状态；
// - 响应中不回显内部上游地址。
import fs from "node:fs";
import path from "node:path";
import type { HealthState, ToolStatus } from "./types";
import { configDir } from "./tools";

interface HealthEntry {
  url: string;
  expectedStatus?: number;
}

const CHECK_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 3_000;
const UNAVAILABLE_AFTER_FAILURES = 2;
const CONCURRENCY = 4;

interface CacheEntry {
  state: HealthState;
  reason?: ToolStatus["reason"];
  checkedAt: string;
  consecutiveFailures: number;
}

const cache = new Map<string, CacheEntry>();

function loadHealthConfig(): Record<string, HealthEntry> {
  const file = process.env.PORTAL_HEALTH_CONFIG ?? path.join(configDir(), "health.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const checks = (parsed as Record<string, unknown>).checks;
    if (typeof checks !== "object" || checks === null) return {};
    const out: Record<string, HealthEntry> = {};
    for (const [id, value] of Object.entries(checks as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null && typeof (value as HealthEntry).url === "string") {
        out[id] = value as HealthEntry;
      }
    }
    return out;
  } catch {
    // 无 health.json：全部工具按“未监测”处理。
    return {};
  }
}

async function probe(entry: HealthEntry): Promise<{ ok: boolean; reason?: ToolStatus["reason"] }> {
  try {
    const res = await fetch(entry.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    const expected = entry.expectedStatus ?? 200;
    return res.status === expected ? { ok: true } : { ok: false, reason: "status" };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network" };
  }
}

function mergeState(id: string, ok: boolean, reason?: ToolStatus["reason"]): CacheEntry {
  const prev = cache.get(id);
  if (ok) {
    const entry: CacheEntry = { state: "ok", checkedAt: new Date().toISOString(), consecutiveFailures: 0 };
    cache.set(id, entry);
    return entry;
  }
  const failures = (prev?.consecutiveFailures ?? 0) + 1;
  const entry: CacheEntry = {
    // 单次失败保留前次状态（PRD §7.1）；无前次或前次已是 unknown 时保持 unknown。
    state:
      prev && (prev.state === "ok" || prev.state === "unreachable")
        ? failures >= UNAVAILABLE_AFTER_FAILURES
          ? "unreachable"
          : prev.state
        : failures >= UNAVAILABLE_AFTER_FAILURES
          ? "unreachable"
          : "unknown",
    reason,
    checkedAt: new Date().toISOString(),
    consecutiveFailures: failures,
  };
  cache.set(id, entry);
  return entry;
}

export async function getStatuses(): Promise<ToolStatus[]> {
  const checks = loadHealthConfig();
  const ids = Object.keys(checks);

  const results = new Map<string, ToolStatus>();
  const now = new Date().toISOString();
  for (const id of ids) results.set(id, { id, state: "unknown", checkedAt: null });

  const queue = [...ids];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      const entry = checks[id];
      const cached = cache.get(id);
      if (cached && Date.now() - new Date(cached.checkedAt).getTime() < CHECK_INTERVAL_MS) {
        results.set(id, {
          id,
          state: cached.state,
          checkedAt: cached.checkedAt,
          reason: cached.reason,
        });
        continue;
      }
      const probeResult = await probe(entry);
      const merged = mergeState(id, probeResult.ok, probeResult.reason);
      results.set(id, {
        id,
        state: merged.state,
        checkedAt: merged.checkedAt,
        reason: merged.reason,
      });
    }
  });
  await Promise.all(workers);

  const out: ToolStatus[] = [];
  for (const [id, status] of results) out.push(status);
  return out;
}
