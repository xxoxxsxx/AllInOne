// node --test 专用：把 "@/..." 与缺 .ts 扩展名的相对导入解析到 src/ 下，
// 使模块代码在无打包器的测试环境可用。
// 用法：node --experimental-strip-types --import ./tests/stocks/alias-loader.ts --test ...
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const HOOKS = path.resolve(import.meta.dirname ?? ".", "alias-hooks.ts");
register(pathToFileURL(HOOKS).href);
