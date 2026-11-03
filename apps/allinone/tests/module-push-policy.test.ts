import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { EMPTY_CHANNEL_CONFIG } from "../src/lib/channels/center.ts";
import { filterModuleChannels, getModulePolicy, saveModulePolicy } from "../src/lib/channels/module-policy.ts";

test("modules have independent default-off settings and selections persist", () => {
  const db = new Database(":memory:");
  const a = getModulePolicy(db, "stocks");
  assert.deepEqual(a, { enabled: false, bark: true, feishu: true, telegram: true });
  saveModulePolicy(db, "stocks", { enabled: true, bark: true, feishu: false, telegram: false });
  assert.equal(getModulePolicy(db, "stocks").enabled, true);
  assert.equal(getModulePolicy(db, "reminders").enabled, false);
  assert.equal(getModulePolicy(db, "documents", true).feishu, true);
  saveModulePolicy(db, "reminders", { enabled: false, bark: false, feishu: true, telegram: true });
  assert.equal(getModulePolicy(db, "stocks").bark, true);
  assert.equal(getModulePolicy(db, "reminders").bark, false);
  db.close();
});

test("module selection cannot enable a globally disabled channel", () => {
  const global = { ...EMPTY_CHANNEL_CONFIG, BarkEnabled: true, FeishuEnabled: false, TGEnabled: true };
  const filtered = filterModuleChannels(global, { enabled: true, bark: false, feishu: true, telegram: true });
  assert.equal(filtered.BarkEnabled, false);
  assert.equal(filtered.FeishuEnabled, false);
  assert.equal(filtered.TGEnabled, true);
  assert.equal(global.BarkEnabled, true);
});
