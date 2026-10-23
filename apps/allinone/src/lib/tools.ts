// 服务端工具目录加载（PRD §6.2/§6.3）。
// 事实源是仓库中的 config/*.json；容器内通过 PORTAL_CONFIG_DIR 挂载，
// 开发态默认解析到仓库根的 config 目录。
import fs from "node:fs";
import path from "node:path";
import type { CategoryConfig, ToolConfig } from "./types";

export const RESERVED_PREFIXES = [
  "/tools",
  "/status",
  "/preferences",
  "/api",
  "/_next",
] as const;

export function configDir(): string {
  return process.env.PORTAL_CONFIG_DIR ?? path.resolve(process.cwd(), "../../config");
}

function readJsonFile<T>(file: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(path.join(configDir(), file), "utf8");
    return { ok: true, data: JSON.parse(raw) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isToolConfig(value: unknown): value is ToolConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    typeof v.category === "string" &&
    typeof v.icon === "string" &&
    typeof v.entry === "string" &&
    typeof v.openMode === "string" &&
    typeof v.visible === "boolean" &&
    typeof v.lifecycle === "string" &&
    typeof v.integration === "string" &&
    typeof v.kind === "string"
  );
}

export interface Catalog {
  tools: ToolConfig[];
  categories: CategoryConfig[];
  error: string | null;
}

// 读取并做最低限度的运行时整形；完整校验由 scripts/validate-config.ts 在发布前负责。
// 配置读取失败时不抛出，返回 error，让页面展示可理解的失败状态而不是白屏。
export function loadCatalog(): Catalog {
  const toolsRaw = readJsonFile<unknown>("tools.json");
  const categoriesRaw = readJsonFile<unknown>("categories.json");
  if (!toolsRaw.ok) {
    return { tools: [], categories: [], error: `tools.json 读取失败：${toolsRaw.error}` };
  }
  if (!categoriesRaw.ok) {
    return { tools: [], categories: [], error: `categories.json 读取失败：${categoriesRaw.error}` };
  }
  if (!Array.isArray(toolsRaw.data) || !Array.isArray(categoriesRaw.data)) {
    return { tools: [], categories: [], error: "工具配置格式不正确" };
  }

  const tools = toolsRaw.data.filter(isToolConfig);
  const categories = categoriesRaw.data.filter(
    (c): c is CategoryConfig =>
      typeof c === "object" && c !== null && typeof (c as CategoryConfig).id === "string" && typeof (c as CategoryConfig).name === "string",
  );

  // 仅展示 visible 工具；隐藏工具的详情路由按不存在处理（PRD §5.6）。
  const visible = tools
    .filter((t) => t.visible)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));

  return { tools: visible, categories, error: null };
}

export function categoryMap(categories: CategoryConfig[]): Map<string, CategoryConfig> {
  return new Map(categories.map((c) => [c.id, c]));
}

// 公开入口（门户自身路由）之外，一级路径必须归属某个工具，避免歧义跳转。
// 供详情页与未来的网关校验使用；完整冲突校验在 validate-config.ts。
export function findToolById(tools: ToolConfig[], id: string): ToolConfig | undefined {
  return tools.find((t) => t.id === id);
}
