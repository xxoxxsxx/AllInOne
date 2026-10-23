// 公共导航与 basePath 感知的路径辅助（AllInOne PRD §5.5/§6.4）。
// next/link 与 redirect 在 basePath 下通常已自动处理，
// 但手工字符串路径（href="/"、redirect("/events")）必须走这里统一加前缀。
// 服务端与客户端均可使用：构建期由 next.config.ts 注入的同一环境变量驱动。
export function appBase(): string {
  // 客户端：Next 会内联 NEXT_PUBLIC_* ；服务端：直接读环境变量。
  const raw =
    typeof process !== "undefined" && process.env?.NEXT_PUBLIC_BASE_PATH
      ? process.env.NEXT_PUBLIC_BASE_PATH
      : "";
  return raw.replace(/\/+$/, "");
}

export function withBase(path: string): string {
  const base = appBase();
  if (!base) return path;
  if (path === base || path.startsWith(`${base}/`)) return path;
  if (!path.startsWith("/")) return `${base}/${path}`;
  if (path === "/") return `${base}/`;
  return `${base}${path}`;
}
