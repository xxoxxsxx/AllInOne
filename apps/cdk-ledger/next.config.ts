import path from "node:path";
import type { NextConfig } from "next";

// basePath：聚合站点的公开前缀（AllInOne PRD §6.4/§8.1）。
// 构建期注入：NEXT_PUBLIC_BASE_PATH=/ledger 时站点挂在 /ledger/ 下；
// 未设置时保持根路径部署，行为与原版一致。
const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, "") || undefined;

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd()),
};

export default nextConfig;
