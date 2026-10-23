// 工具目录配置校验（PRD §6.2/§6.3、§13）。
// 运行：node --experimental-strip-types scripts/validate-config.ts
// 任何错误都以非零码退出并保留旧配置可用（发布前把关）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_IDS } from "../apps/portal/src/lib/icons.ts";
import { RESERVED_PREFIXES } from "../apps/portal/src/lib/tools.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = process.env.PORTAL_CONFIG_DIR ?? path.join(repoRoot, "config");

interface Category {
  id: string;
  name: string;
  description?: string;
}

interface Tool {
  id: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
  aliases?: string[];
  icon: string;
  kind: string;
  entry: string;
  openMode: string;
  order?: number;
  visible: boolean;
  lifecycle: string;
  maintenanceMessage?: string;
  integration: string;
}

const errors: string[] = [];

function load<T>(file: string): T {
  const full = path.join(configDir, file);
  let raw: string;
  try {
    raw = fs.readFileSync(full, "utf8");
  } catch (err) {
    errors.push(`${file} 无法读取: ${err instanceof Error ? err.message : String(err)}`);
    return [] as unknown as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    errors.push(`${file} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
    return [] as unknown as T;
  }
}

const categories = load<Category[]>("categories.json");
const tools = load<Tool[]>("tools.json");

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KINDS = new Set(["static", "service", "external"]);
const LIFECYCLES = new Set(["active", "maintenance"]);
const INTEGRATIONS = new Set(["path", "host", "external"]);
const OPEN_MODES = new Set(["same-tab", "new-tab"]);

const categoryIds = new Set<string>();
for (const cat of categories) {
  if (!cat || typeof cat.id !== "string" || !ID_RE.test(cat.id)) {
    errors.push(`categories.json: 分类 id 非法（须为小写短横线）: ${JSON.stringify(cat?.id)}`);
    continue;
  }
  if (categoryIds.has(cat.id)) errors.push(`categories.json: 分类 id 重复: ${cat.id}`);
  if (typeof cat.name !== "string" || cat.name.trim() === "") {
    errors.push(`categories.json: 分类 ${cat.id} 缺少 name`);
  }
  categoryIds.add(cat.id);
}

const seenIds = new Set<string>();
const seenPathEntries = new Set<string>();
const reserved = RESERVED_PREFIXES as readonly string[];

for (const tool of tools) {
  const label = `tools.json [${typeof tool?.id === "string" ? tool.id : "<无 id>"}]`;
  if (!tool || typeof tool !== "object") {
    errors.push("tools.json: 存在非对象条目");
    continue;
  }
  if (typeof tool.id !== "string" || !ID_RE.test(tool.id)) {
    errors.push(`${label}: id 非法（须为小写短横线）`);
    continue;
  }
  if (seenIds.has(tool.id)) errors.push(`${label}: id 重复`);
  seenIds.add(tool.id);

  for (const field of ["name", "description", "icon", "entry", "openMode", "kind", "integration", "lifecycle"] as const) {
    if (typeof tool[field] !== "string" || (tool[field] as string).trim() === "") {
      errors.push(`${label}: 缺少或非法字段 ${field}`);
    }
  }
  if (typeof tool.visible !== "boolean") errors.push(`${label}: visible 必须为布尔值`);

  if (categoryIds.size > 0 && !categoryIds.has(tool.category)) {
    errors.push(`${label}: 未知分类 ${JSON.stringify(tool.category)}`);
  }
  if (!ICON_IDS.includes(tool.icon)) {
    errors.push(`${label}: icon 不在白名单: ${JSON.stringify(tool.icon)}（可用: ${ICON_IDS.join(", ")}）`);
  }
  if (!KINDS.has(tool.kind)) errors.push(`${label}: kind 非法: ${JSON.stringify(tool.kind)}`);
  if (!LIFECYCLES.has(tool.lifecycle)) errors.push(`${label}: lifecycle 非法: ${JSON.stringify(tool.lifecycle)}`);
  if (!INTEGRATIONS.has(tool.integration)) {
    errors.push(`${label}: integration 非法: ${JSON.stringify(tool.integration)}`);
  }
  if (!OPEN_MODES.has(tool.openMode)) errors.push(`${label}: openMode 非法: ${JSON.stringify(tool.openMode)}`);

  if (tool.lifecycle === "maintenance" && typeof tool.maintenanceMessage !== "string") {
    errors.push(`${label}: maintenance 状态必须提供 maintenanceMessage`);
  }

  if (tool.integration === "external") {
    let ok = false;
    try {
      const url = new URL(tool.entry);
      ok = url.protocol === "http:" || url.protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) errors.push(`${label}: external 工具的 entry 必须是 http(s) URL`);
  } else if (typeof tool.entry === "string" && tool.entry.startsWith("/")) {
    // 站内路径：校验前缀冲突与保留字（PRD §6.4）。
    const entryPath = tool.entry;
    for (const r of reserved) {
      if (entryPath === r || entryPath.startsWith(`${r}/`)) {
        errors.push(`${label}: entry ${entryPath} 与门户保留前缀 ${r} 冲突`);
      }
    }
    for (const other of seenPathEntries) {
      if (entryPath === other || entryPath.startsWith(`${other}/`) || other.startsWith(`${entryPath}/`)) {
        errors.push(`${label}: entry ${entryPath} 与已有工具路径 ${other} 前缀冲突`);
      }
    }
    seenPathEntries.add(entryPath);
  } else {
    errors.push(`${label}: integration 为 ${tool.integration} 时 entry 必须是站内路径`);
  }

  if (tool.order !== undefined && (typeof tool.order !== "number" || !Number.isInteger(tool.order) || tool.order < 0)) {
    errors.push(`${label}: order 必须为非负整数`);
  }
}

if (errors.length > 0) {
  console.error(`工具配置校验失败（${errors.length} 项）：`);
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}

console.log(`配置校验通过：${tools.length} 个工具、${categories.length} 个分类。`);
