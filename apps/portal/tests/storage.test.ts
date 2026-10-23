import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  clearAllPreferences,
  pushRecent,
  readFavorites,
  readRecent,
  readTheme,
  toggleFavorite,
  writeTheme,
} from "../src/lib/storage.ts";

// node 环境无 localStorage：本组测试同时验证内存兜底路径。
beforeEach(() => {
  clearAllPreferences();
});

afterEach(() => {
  clearAllPreferences();
});

test("收藏切换与去重", () => {
  assert.equal(toggleFavorite("a"), true);
  assert.equal(toggleFavorite("b"), true);
  assert.deepEqual(readFavorites(), ["b", "a"]);
  assert.equal(toggleFavorite("a"), false);
  assert.deepEqual(readFavorites(), ["b"]);
  assert.equal(toggleFavorite("a"), true);
  assert.deepEqual(readFavorites(), ["a", "b"]);
});

test("最近打开：最新在前、去重、上限 6", () => {
  for (const id of ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]) pushRecent(id);
  assert.deepEqual(readRecent(), ["t7", "t6", "t5", "t4", "t3", "t2"]);
  pushRecent("t3");
  assert.deepEqual(readRecent(), ["t3", "t7", "t6", "t5", "t4", "t2"]);
});

test("主题默认 system，写入后可读回", () => {
  writeTheme("dark");
  assert.equal(readTheme(), "dark");
});

test("清除偏好后回到空态", () => {
  toggleFavorite("x");
  pushRecent("x");
  writeTheme("light");
  clearAllPreferences();
  assert.deepEqual(readFavorites(), []);
  assert.deepEqual(readRecent(), []);
  assert.equal(readTheme(), "system");
});
