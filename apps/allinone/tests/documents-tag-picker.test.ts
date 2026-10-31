// tag-picker 纯逻辑测试：不依赖 DOM / React。
//
// tag-picker.tsx 是 TSX（node strip-types 不识别 .tsx 扩展名），无法被测试直接 import；
// 因此这里读取源码，截取「PURE-HELPERS BEGIN/END」标记之间的纯函数区块（约定该区块
// 无 import、无 JSX、自包含），写入临时 .ts 交给 node --experimental-strip-types 加载。
// 这样测试的是组件运行时引用的同一份实现，而不是测试内的复制品。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_URL = new URL("../src/app/documents/tag-picker.tsx", import.meta.url);
const BEGIN_MARK = "// >>> PURE-HELPERS BEGIN";
const END_MARK = "// >>> PURE-HELPERS END";

type AddTagsResult =
  | { ok: true; tags: string[] }
  | { ok: false; error: string };

type Helpers = {
  MAX_TAGS: number;
  MAX_TAG_LENGTH: number;
  MAX_SUGGESTIONS: number;
  containsTagSeparator: (raw: string) => boolean;
  addTagsFromInput: (current: string[], raw: string) => AddTagsResult;
  filterTagSuggestions: (
    options: Array<{ id: number; name: string }>,
    input: string,
    selected: string[],
    limit?: number,
  ) => Array<{ id: number; name: string }>;
};

async function loadPureHelpers(): Promise<Helpers> {
  const source = fs.readFileSync(SOURCE_URL, "utf8");
  const begin = source.indexOf(BEGIN_MARK);
  const end = source.indexOf(END_MARK);
  assert.ok(begin >= 0, "tag-picker.tsx 缺少 PURE-HELPERS BEGIN 标记");
  assert.ok(end > begin, "tag-picker.tsx 缺少 PURE-HELPERS END 标记");
  const block = source.slice(begin + BEGIN_MARK.length, end);
  assert.ok(!/\bimport\b/.test(block), "纯函数区不得包含 import（须自包含）");
  assert.ok(!/^[ \t]*</m.test(block), "纯函数区不得包含 JSX");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tag-picker-helpers-"));
  try {
    const file = path.join(dir, "helpers.ts");
    fs.writeFileSync(file, block, "utf8");
    return (await import(pathToFileURL(file).href)) as Helpers;
  } finally {
    // 模块已加载进内存，临时目录可立即清理。
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const { MAX_TAGS, MAX_TAG_LENGTH, MAX_SUGGESTIONS, containsTagSeparator, addTagsFromInput, filterTagSuggestions } =
  await loadPureHelpers();

function expectOk(result: AddTagsResult): string[] {
  if (result.ok) return result.tags;
  throw new Error(`应当通过，却被拒绝：${result.error}`);
}

function expectError(result: AddTagsResult, fragment: string): string {
  if (result.ok) throw new Error(`应当被拒绝，却通过了：${JSON.stringify(result.tags)}`);
  assert.ok(result.error.includes(fragment), `提示应包含「${fragment}」，实际：「${result.error}」`);
  return result.error;
}

test("限制常量与服务端 upsertTags 保持一致", () => {
  assert.equal(MAX_TAGS, 20);
  assert.equal(MAX_TAG_LENGTH, 40);
  assert.equal(MAX_SUGGESTIONS, 8);
});

test("回车语义：整段输入作为一个标签，含内部空格的中文标签不被拆散", () => {
  assert.deepEqual(expectOk(addTagsFromInput([], "北京 常用")), ["北京 常用"]);
  assert.deepEqual(expectOk(addTagsFromInput([], "travel docs 2024")), ["travel docs 2024"]);
  assert.deepEqual(expectOk(addTagsFromInput([], "有效期证明 副本")), ["有效期证明 副本"]);
});

test("半角逗号 / 中文逗号 / 顿号 / 半角全角分号都会切分，并去首尾空格", () => {
  assert.deepEqual(expectOk(addTagsFromInput([], "出行,常用")), ["出行", "常用"]);
  assert.deepEqual(expectOk(addTagsFromInput([], "出行，常用")), ["出行", "常用"]);
  assert.deepEqual(expectOk(addTagsFromInput([], "出行、常用")), ["出行", "常用"]);
  assert.deepEqual(expectOk(addTagsFromInput([], "出行;常用")), ["出行", "常用"]);
  assert.deepEqual(expectOk(addTagsFromInput([], "出行；常用")), ["出行", "常用"]);
  assert.deepEqual(expectOk(addTagsFromInput([], "  出行 ,  常用  ")), ["出行", "常用"]);
});

test("空格不切分：ASCII 词组保持完整（分隔规则有意从简）", () => {
  assert.deepEqual(expectOk(addTagsFromInput([], "go pro")), ["go pro"]);
  assert.deepEqual(expectOk(addTagsFromInput(["x"], "a b,c")), ["x", "a b", "c"]);
  assert.equal(containsTagSeparator("a b"), false);
});

test("空段与纯分隔符是无操作：返回原数组引用且不产生新标签", () => {
  const current = ["a"];
  const res = addTagsFromInput(current, " , , ，");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.tags, current); // 同一引用，组件据此跳过 onChange
  assert.equal(expectOk(addTagsFromInput([], "   ")).length, 0);
});

test("与已有标签重复（大小写不敏感）时拒绝并内联提示", () => {
  expectError(addTagsFromInput(["旅行"], "旅行"), "已存在");
  expectError(addTagsFromInput(["Travel"], "travel"), "「travel」已存在");
  expectError(addTagsFromInput(["travel docs"], "TRAVEL DOCS"), "已存在");
  // 注意：批内互相重复（如 "a,a"）不算与已有标签冲突，由「批内去重」用例覆盖。
});

test("含空格的变体不算重复：与已有标签逐字符比较（仅大小写不敏感）", () => {
  assert.deepEqual(expectOk(addTagsFromInput(["护照"], "护 照")), ["护照", "护 照"]);
});

test("批内重复只保留首个写法；中文不受大小写折叠影响", () => {
  assert.deepEqual(expectOk(addTagsFromInput([], "a,A,a")), ["a"]);
  assert.deepEqual(expectOk(addTagsFromInput([], "标签,标签")), ["标签"]);
  assert.deepEqual(expectOk(addTagsFromInput([], "  出行 , 出行 ,常用")), ["出行", "常用"]);
});

test("最多 20 个标签：第 20 个可通过，超出即拒绝", () => {
  const nineteen = Array.from({ length: 19 }, (_, i) => `标签${i + 1}`);
  assert.equal(expectOk(addTagsFromInput(nineteen, "第20个")).length, 20);
  expectError(addTagsFromInput(nineteen, "第20个,第21个"), "最多 20 个标签");
  const twenty = [...nineteen, "第20个"];
  expectError(addTagsFromInput(twenty, "第21个"), "20");
});

test("单个标签最多 40 个字符（去首尾空格后，中文按字符数计）", () => {
  const cjk40 = "签".repeat(40);
  const cjk41 = "签".repeat(41);
  assert.deepEqual(expectOk(addTagsFromInput([], cjk40)), [cjk40]);
  expectError(addTagsFromInput([], cjk41), "40");
  assert.deepEqual(expectOk(addTagsFromInput([], `  ${"a".repeat(40)}  `)), ["a".repeat(40)]);
  expectError(addTagsFromInput([], "a".repeat(41)), "40");
  // 校验顺序与服务端一致：先数量后长度。
  const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
  expectError(addTagsFromInput(twenty, `${"a".repeat(41)},b`), "20");
});

test("containsTagSeparator 只识别逗号家族与分号", () => {
  for (const sep of [",", "，", "、", ";", "；"]) {
    assert.equal(containsTagSeparator(`a${sep}b`), true, sep);
  }
  for (const plain of ["", "abc", "a b", "a.b", "a（b）"]) {
    assert.equal(containsTagSeparator(plain), false, plain);
  }
});

function opt(id: number, name: string): { id: number; name: string } {
  return { id, name };
}

test("filterTagSuggestions：排除已选（大小写不敏感）、按子串过滤、默认上限 8", () => {
  const options = [
    opt(1, "出行"),
    opt(2, "常用"),
    opt(3, "Travel"),
    opt(4, "travel docs"),
    opt(5, "证件"),
    opt(6, "护照"),
    opt(7, "签证"),
    opt(8, "驾照"),
    opt(9, "社保"),
    opt(10, "保单"),
  ];
  // 输入为空：排除已选后按原顺序返回前 8 条。
  assert.deepEqual(filterTagSuggestions(options, "", ["出行"]).map((t) => t.name), [
    "常用", "Travel", "travel docs", "证件", "护照", "签证", "驾照", "社保",
  ]);
  // 大小写不敏感排除。
  assert.equal(filterTagSuggestions(options, "", ["TRAVEL"]).some((t) => t.name.toLowerCase() === "travel"), false);
  // 子串过滤（大小写不敏感）。
  assert.deepEqual(filterTagSuggestions(options, "TRAVEL", []).map((t) => t.name), ["Travel", "travel docs"]);
  assert.deepEqual(filterTagSuggestions(options, "签", []).map((t) => t.name), ["签证"]);
  // 无匹配 → 空数组。
  assert.deepEqual(filterTagSuggestions(options, "不存在", []), []);
  // 全部已选 → 空数组。
  assert.deepEqual(
    filterTagSuggestions(options.slice(0, 2), "", ["出行", "常用"]),
    [],
  );
  // 显式 limit 覆盖默认值。
  assert.equal(filterTagSuggestions(options, "", [], 3).length, 3);
});
