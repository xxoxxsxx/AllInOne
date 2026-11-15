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

// 3. Server Actions 引用的 next/cache 与 next/navigation 在 Node 测试环境中不存在，
//    用最小实现替换：revalidatePath 为空操作，redirect 抛出带 digest 的错误（Next 同款契约）。
const REDIRECT_ERROR = "NEXT_REDIRECT";
const redirectBody = `
function redirect(url) { throw Object.assign(new Error(${JSON.stringify(REDIRECT_ERROR)}), { digest: "NEXT_REDIRECT;" + url }); }
function notFound() { throw new Error("NEXT_NOT_FOUND"); }
export { redirect, notFound };
`;
function redirectStub(url: string): never {
  throw Object.assign(new Error(REDIRECT_ERROR), { digest: `${REDIRECT_ERROR};${url}` });
}
function stub(path: string, exports: Record<string, unknown>) {
  return { url: `data:text/javascript,${Object.entries(exports).map(([k, v]) => `export const ${k} = ${String(v)}`).join(";\n")}`, shortCircuit: true };
}

export function resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
  if (specifier === "next/cache") return stub(specifier, { revalidatePath: "() => {}" });
  if (specifier === "next/navigation") return { url: `data:text/javascript,${encodeURIComponent(redirectBody)}`, shortCircuit: true };
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
