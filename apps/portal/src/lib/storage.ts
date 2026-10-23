// 浏览器本地偏好存储（PRD §5.4、§10.1）：
// - 统一命名空间 allinone:v1:*；
// - localStorage 不可用时退化为页面内存状态，工具仍能打开；
// - 不记录业务数据、业务 URL 查询内容。
// 此文件必须在 node（无 window）环境下可安全加载，便于单元测试。
const PREFIX = "allinone:v1:";
const RECENT_LIMIT = 6;
const FAVORITES_LIMIT = 50;

const memory = new Map<string, string>();

function backend(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const probeKey = `${PREFIX}__probe__`;
      window.localStorage.setItem(probeKey, "1");
      window.localStorage.removeItem(probeKey);
      return window.localStorage;
    }
  } catch {
    // 存储被禁用或不可写，走内存兜底。
  }
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
  };
}

function readList(key: string, limit: number): string[] {
  try {
    const raw = backend().getItem(PREFIX + key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string" || item.length === 0) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

function writeList(key: string, items: string[], limit: number): void {
  const capped = [...new Set(items)].slice(0, limit);
  try {
    backend().setItem(PREFIX + key, JSON.stringify(capped));
  } catch {
    // 写入失败时保持内存态即可，不向上抛。
  }
}

export function readFavorites(): string[] {
  return readList("favorites", FAVORITES_LIMIT);
}

export function isFavorite(id: string): boolean {
  return readFavorites().includes(id);
}

export function toggleFavorite(id: string): boolean {
  const current = readFavorites();
  let next: string[];
  let nowFavorite: boolean;
  if (current.includes(id)) {
    next = current.filter((x) => x !== id);
    nowFavorite = false;
  } else {
    next = [id, ...current];
    nowFavorite = true;
  }
  writeList("favorites", next, FAVORITES_LIMIT);
  return nowFavorite;
}

export function readRecent(): string[] {
  return readList("recent", RECENT_LIMIT);
}

// 仅在用户从门户实际“打开”工具时调用（不跟踪详情页浏览）。
export function pushRecent(id: string): void {
  const current = readList("recent", RECENT_LIMIT);
  writeList("recent", [id, ...current.filter((x) => x !== id)], RECENT_LIMIT);
}

export function readTheme(): "light" | "dark" | "system" {
  const value = backend().getItem(PREFIX + "theme");
  if (value === "light" || value === "dark") return value;
  return "system";
}

export function writeTheme(theme: "light" | "dark" | "system"): void {
  try {
    backend().setItem(PREFIX + "theme", theme);
  } catch {
    // 内存兜底。
  }
}

// 清除本机收藏、最近打开与主题（PRD §5.7），只删本应用命名空间下的键。
export function clearAllPreferences(): void {
  const store = backend();
  const own = new Set([
    `${PREFIX}favorites`,
    `${PREFIX}recent`,
    `${PREFIX}theme`,
  ]);
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(PREFIX)) window.localStorage.removeItem(key);
      }
    } else {
      for (const key of memory.keys()) {
        if (key.startsWith(PREFIX)) memory.delete(key);
      }
    }
    void own;
  } catch {
    memory.clear();
  }
}
