// alias-loader 的 resolve 钩子（在测试子进程中执行）。
// 处理两类情况：
// 1. "@/..." → src/ 下对应文件；
// 2. 相对/绝对导入缺 .ts 扩展名 → 尝试补 .ts / /index.ts。
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, statSync } from "node:fs";

const APP_SRC = path.resolve(import.meta.dirname ?? ".", "../../src");

function tryFile(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base;
  if (existsSync(base + ".ts")) return base + ".ts";
  if (existsSync(base + ".tsx")) return base + ".tsx";
  if (existsSync(path.join(base, "index.ts"))) return path.join(base, "index.ts");
  return null;
}

export function resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
  if (specifier.startsWith("@/")) {
    const found = tryFile(path.join(APP_SRC, specifier.slice(2)));
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const found = tryFile(path.resolve(parentDir, specifier));
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
