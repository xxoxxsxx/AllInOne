import type Database from "better-sqlite3";
import type { ChannelConfig } from "@/modules/stocks/notify";

export type ModuleName = "stocks" | "documents" | "reminders";
export type ModulePolicy = { enabled: boolean; bark: boolean; feishu: boolean; telegram: boolean };

/** 模块策略保存在对应模块的数据库，与全局凭据分开。新模块总开关默认关闭。 */
export function getModulePolicy(db: Database.Database, module: ModuleName, defaultEnabled = false): ModulePolicy {
  db.exec(`CREATE TABLE IF NOT EXISTS module_push_policy (
    module TEXT PRIMARY KEY, enabled INTEGER NOT NULL, bark INTEGER NOT NULL,
    feishu INTEGER NOT NULL, telegram INTEGER NOT NULL
  )`);
  const row = db.prepare("SELECT enabled,bark,feishu,telegram FROM module_push_policy WHERE module=?").get(module) as
    | { enabled: number; bark: number; feishu: number; telegram: number } | undefined;
  return row ? { enabled: row.enabled === 1, bark: row.bark === 1, feishu: row.feishu === 1, telegram: row.telegram === 1 }
    : { enabled: defaultEnabled, bark: true, feishu: true, telegram: true };
}

export function saveModulePolicy(db: Database.Database, module: ModuleName, policy: ModulePolicy): void {
  getModulePolicy(db, module);
  db.prepare(`INSERT INTO module_push_policy(module,enabled,bark,feishu,telegram) VALUES(?,?,?,?,?)
    ON CONFLICT(module) DO UPDATE SET enabled=excluded.enabled,bark=excluded.bark,feishu=excluded.feishu,telegram=excluded.telegram`)
    .run(module, policy.enabled ? 1 : 0, policy.bark ? 1 : 0, policy.feishu ? 1 : 0, policy.telegram ? 1 : 0);
}

/** 相交模块渠道选择与全局开关；不修改原有渠道配置。 */
export function filterModuleChannels(config: ChannelConfig, policy: ModulePolicy): ChannelConfig {
  return { ...config, Bark: { ...config.Bark }, BarkEnabled: config.BarkEnabled && policy.bark,
    FeishuEnabled: config.FeishuEnabled && policy.feishu, TGEnabled: config.TGEnabled && policy.telegram };
}
