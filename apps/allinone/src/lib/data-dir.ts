import path from "node:path";

// 数据根目录：容器内为 /data（卷挂载），本地开发默认仓库内 ./data。
export function dataDir(): string {
  const raw = process.env.DATA_DIR;
  if (raw && raw.trim() !== "") return path.resolve(raw);
  return path.resolve(process.cwd(), "data");
}
