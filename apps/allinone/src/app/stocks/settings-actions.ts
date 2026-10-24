"use server";

// 设置页（settingsPage/settingsPost + level_web.go 测试通知）与调度页
// （schedule/scheduleLoop 的 CRUD 与 windowSave/windowDefault/zonePost）的 Server Actions。

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getDB, now as nowText, validWindow, queryWindows } from "@/modules/stocks/store";
import { checkBarkURL, checkFeishuWebhook, checkProxy, checkTG, sendChannel, testProxy } from "@/modules/stocks/notify";
import { parseClock } from "@/modules/stocks/tz";
import { activeWindow, occurrence, timezoneValue, validTimezone, windowsOverlap } from "@/modules/stocks/windows";

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

function has(fd: FormData, key: string): boolean {
  return fd.has(key);
}

function goSettings(params: Record<string, string>): never {
  const q = new URLSearchParams(params);
  redirect(`/stocks/settings${q.toString() ? `?${q}` : ""}`);
}

function goSchedule(params: Record<string, string>): never {
  const q = new URLSearchParams(params);
  redirect(`/stocks/schedule${q.toString() ? `?${q}` : ""}`);
}

// —— 行情 Key ——
export async function saveAPIKeyAction(fd: FormData): Promise<void> {
  const db = getDB();
  const key = str(fd, "api_key").trim();
  if (key.length > 256) goSettings({ error: "Key 过长" });
  if (str(fd, "clear") !== "1" && key === "") goSettings({ result: "unchanged" });
  const finalKey = str(fd, "clear") === "1" ? "" : key;
  db.prepare(`UPDATE settings SET api_key=? WHERE id=1`).run(finalKey);
  goSettings({ result: str(fd, "clear") === "1" ? "cleared" : "saved" });
}

// —— 共享行情额度 ——
export async function saveQuotaAction(fd: FormData): Promise<void> {
  const minute = Number(str(fd, "quota_per_minute"));
  const day = Number(str(fd, "quota_per_day"));
  if (!Number.isSafeInteger(minute) || minute < 1 || minute > 100000 ||
      !Number.isSafeInteger(day) || day < 1 || day > 100000000) {
    goSettings({ error: "分钟额度须为 1～100000 的整数，24 小时额度须为 1～100000000 的整数。" });
  }
  getDB().prepare(`UPDATE settings SET quota_per_minute=?,quota_per_day=? WHERE id=1`).run(minute, day);
  revalidatePath("/stocks/settings");
  goSettings({ result: "quota_saved" });
}

// —— 代理 ——
export async function clearProxyAction(): Promise<void> {
  const db = getDB();
  db.prepare(`UPDATE settings SET proxy_url='',proxy_latency_ms='',proxy_tested_at='',bark_proxy=0,feishu_proxy=0,tg_proxy=0 WHERE id=1`).run();
  goSettings({ result: "cleared" });
}

export async function saveProxyAction(fd: FormData): Promise<void> {
  const db = getDB();
  let raw = str(fd, "proxy_url");
  if (has(fd, "proxy_test")) {
    raw = (db.prepare(`SELECT proxy_url FROM settings WHERE id=1`).get() as { proxy_url: string }).proxy_url;
  }
  let proxy: string;
  try {
    proxy = checkProxy(raw);
  } catch {
    goSettings({ error: "请填写有效的 HTTP 或 SOCKS5 代理地址和端口" });
  }
  if (!proxy) goSettings({ error: "请填写有效的 HTTP 或 SOCKS5 代理地址和端口" });
  try {
    const latency = await testProxy(proxy);
    db.prepare(`UPDATE settings SET proxy_url=?,proxy_latency_ms=?,proxy_tested_at=? WHERE id=1`).run(proxy, latency, nowText());
  } catch (e) {
    goSettings({ error: `代理测试失败：${e instanceof Error ? e.message : "未知错误"}` });
  }
  goSettings({ result: "proxy_tested" });
}

// —— Bark ——
export async function saveBarkAction(fd: FormData): Promise<void> {
  const db = getDB();
  const useProxy = str(fd, "use_proxy") === "1";
  if (useProxy) {
    const proxy = (db.prepare(`SELECT proxy_url FROM settings WHERE id=1`).get() as { proxy_url: string }).proxy_url;
    if (proxy === "") goSettings({ error: "请先测试并保存网络代理" });
  }
  const raw = str(fd, "bark_url").trim();
  const key = str(fd, "bark_key").trim();
  if (key.length > 256) goSettings({ error: "设备 Key 过长" });
  let url = raw;
  if (raw !== "") {
    try {
      url = checkBarkURL(raw, str(fd, "allow_local") === "1");
    } catch (e) {
      goSettings({ error: e instanceof Error ? e.message : "Bark 地址无效" });
    }
  }
  const enabled = str(fd, "enabled") === "1";
  if (enabled) {
    const current = db.prepare(`SELECT bark_url,bark_key FROM settings WHERE id=1`).get() as { bark_url: string; bark_key: string };
    if (url === "" || (key === "" && current.bark_key === "")) {
      goSettings({ error: "启用 Bark 前请填写服务地址和设备 Key" });
    }
  }
  db.prepare(`UPDATE settings SET bark_url=?,bark_key=CASE WHEN ?='' THEN bark_key ELSE ? END,bark_local=?,bark_enabled=?,bark_proxy=? WHERE id=1`)
    .run(url, key, key, str(fd, "allow_local") === "1" ? 1 : 0, enabled ? 1 : 0, useProxy ? 1 : 0);
  goSettings({ result: "saved" });
}

export async function clearBarkAction(): Promise<void> {
  const db = getDB();
  db.prepare(`UPDATE settings SET bark_url='',bark_key='',bark_local=0,bark_enabled=0,bark_proxy=0 WHERE id=1`).run();
  goSettings({ result: "cleared" });
}

// —— 飞书 ——
export async function saveFeishuAction(fd: FormData): Promise<void> {
  const db = getDB();
  const useProxy = str(fd, "use_proxy") === "1";
  if (useProxy) {
    const proxy = (db.prepare(`SELECT proxy_url FROM settings WHERE id=1`).get() as { proxy_url: string }).proxy_url;
    if (proxy === "") goSettings({ error: "请先测试并保存网络代理" });
  }
  let webhook: string;
  try {
    webhook = checkFeishuWebhook(str(fd, "feishu_webhook"));
  } catch (e) {
    goSettings({ error: e instanceof Error ? e.message : "飞书 Webhook 无效" });
  }
  const secret = str(fd, "feishu_secret").trim();
  if (secret.length > 256) goSettings({ error: "飞书签名密钥过长" });
  db.prepare(`UPDATE settings SET feishu_webhook=?,feishu_secret=?,feishu_enabled=?,feishu_proxy=? WHERE id=1`)
    .run(webhook, secret, str(fd, "enabled") === "1" ? 1 : 0, useProxy ? 1 : 0);
  goSettings({ result: "saved" });
}

export async function clearFeishuAction(): Promise<void> {
  const db = getDB();
  db.prepare(`UPDATE settings SET feishu_webhook='',feishu_secret='',feishu_enabled=0,feishu_proxy=0 WHERE id=1`).run();
  goSettings({ result: "cleared" });
}

// —— Telegram ——
export async function saveTGAction(fd: FormData): Promise<void> {
  const db = getDB();
  const useProxy = str(fd, "use_proxy") === "1";
  if (useProxy) {
    const proxy = (db.prepare(`SELECT proxy_url FROM settings WHERE id=1`).get() as { proxy_url: string }).proxy_url;
    if (proxy === "") goSettings({ error: "请先测试并保存网络代理" });
  }
  const token = str(fd, "tg_token").trim();
  const chat = str(fd, "tg_chat_id").trim();
  try {
    checkTG(token, chat);
  } catch (e) {
    goSettings({ error: e instanceof Error ? e.message : "Telegram 配置无效" });
  }
  db.prepare(`UPDATE settings SET tg_token=?,tg_chat_id=?,tg_enabled=?,tg_proxy=? WHERE id=1`)
    .run(token, chat, str(fd, "enabled") === "1" ? 1 : 0, useProxy ? 1 : 0);
  goSettings({ result: "saved" });
}

export async function clearTGAction(): Promise<void> {
  const db = getDB();
  db.prepare(`UPDATE settings SET tg_token='',tg_chat_id='',tg_enabled=0,tg_proxy=0 WHERE id=1`).run();
  goSettings({ result: "cleared" });
}

// —— 测试通知（level_web.go barkTest/feishuTest/telegramTest）——
export async function testBarkAction(): Promise<void> {
  const db = getDB();
  const c = db.prepare(`SELECT bark_url,bark_key FROM settings WHERE id=1`).get() as { bark_url: string; bark_key: string };
  if (c.bark_url === "" || c.bark_key === "") goSettings({ error: "请先配置 Bark 地址和设备 Key" });
  const { notificationSettings } = await import("@/modules/stocks/store");
  const outcome = await sendChannel(notificationSettings(db), "Bark", "TickerSentry 测试通知", "测试推送，不涉及股价");
  if (outcome.status !== "成功") goSettings({ error: `${outcome.status}：${outcome.error}` });
  goSettings({ tested: "bark" });
}

export async function testFeishuAction(): Promise<void> {
  const db = getDB();
  const { notificationSettings } = await import("@/modules/stocks/store");
  const c = notificationSettings(db);
  if (c.FeishuWebhook === "") goSettings({ error: "请先配置飞书 Webhook" });
  const outcome = await sendChannel(c, "飞书", "TickerSentry 测试通知", "测试推送，不涉及股价");
  if (outcome.status !== "成功") goSettings({ error: `${outcome.status}：${outcome.error}` });
  goSettings({ tested: "feishu" });
}

export async function testTGAction(): Promise<void> {
  const db = getDB();
  const { notificationSettings } = await import("@/modules/stocks/store");
  const c = notificationSettings(db);
  if (c.TGToken === "" || c.TGChatID === "") goSettings({ error: "请先配置 Telegram Bot Token 和 Chat ID" });
  const outcome = await sendChannel(c, "Telegram", "TickerSentry 测试通知", "测试推送，不涉及股价");
  if (outcome.status !== "成功") goSettings({ error: `${outcome.status}：${outcome.error}` });
  goSettings({ tested: "telegram" });
}

// —— 时段（windows.go windowSave / windowDefault / zonePost）——
export async function windowSaveAction(fd: FormData): Promise<void> {
  const db = getDB();
  const tz = timezoneValue(db);
  const idText = str(fd, "id");
  const id = idText === "" ? 0 : Number(idText);
  const action = str(fd, "action"); // ""=save, delete, enable, disable
  const list = queryWindows(db);
  let previous: (typeof list)[number] | null = null;
  let found = id === 0;
  for (const item of list) {
    if (item.id === id) {
      found = true;
      previous = item;
      if (action === "delete") {
        const occ = occurrence(item, new Date(), tz);
        if (occ.active) {
          goSchedule({ error: "当前处于此时间段内，可暂停查询；请在时段结束后删除，避免重置档位提醒额度。" });
        }
      }
    }
  }
  if (!found) redirect("/stocks/error/404");
  let flash: string;
  if (action === "delete") {
    flash = "window_deleted";
    db.prepare(`DELETE FROM query_windows WHERE id=?`).run(id);
  } else if (action === "disable" || action === "enable") {
    flash = action === "enable" ? "window_enabled" : "window_disabled";
    db.prepare(`UPDATE query_windows SET enabled=? WHERE id=?`).run(action === "enable" ? 1 : 0, id);
  } else if (action === "" || action === "save") {
    flash = "window_saved";
    const startMin = parseClock(str(fd, "start"));
    const endMin = parseClock(str(fd, "end"));
    const interval = Number(str(fd, "interval"));
    const limit = Number(str(fd, "max_alerts"));
    if (startMin === null || endMin === null || !Number.isInteger(interval) || !Number.isInteger(limit)) {
      goSchedule({ error: "开始与结束时间须不同，间隔为 1 分钟至时段长度，每档默认提醒上限为 1～1000 次。" });
    }
    const item = { id, start: startMin, end: endMin, interval, max_alerts: limit, enabled: true };
    if (!validWindow(item)) {
      goSchedule({ error: "开始与结束时间须不同，间隔为 1 分钟至时段长度，每档默认提醒上限为 1～1000 次。" });
    }
    if (previous) {
      const occ = occurrence(previous, new Date(), tz);
      if (occ.active && (item.start !== previous.start || item.end !== previous.end)) {
        goSchedule({ error: "当前时段可修改间隔和提醒上限；起止时间请在时段结束后修改。" });
      }
    }
    for (const other of list) {
      if (other.id !== id && windowsOverlap(item, other)) {
        goSchedule({ error: "查询时段不能重叠（包括已暂停的时段）。" });
      }
    }
    if (id === 0) {
      db.prepare(`INSERT INTO query_windows(start,end,interval,max_alerts) VALUES(?,?,?,?)`).run(item.start, item.end, item.interval, item.max_alerts);
    } else {
      db.prepare(`UPDATE query_windows SET start=?,end=?,interval=?,max_alerts=? WHERE id=?`).run(item.start, item.end, item.interval, item.max_alerts, id);
    }
  } else {
    redirect("/stocks/error/404");
  }
  revalidatePath("/stocks/schedule");
  goSchedule({ flash });
}

export async function windowDefaultAction(fd: FormData): Promise<void> {
  const db = getDB();
  const limit = Number(str(fd, "max_alerts"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    goSchedule({ error: "每档默认提醒上限须为 1～1000 次。" });
  }
  const tx = (db as unknown as { transaction: (fn: () => void) => () => void }).transaction(() => {
    db.prepare(`UPDATE settings SET default_alerts=? WHERE id=1`).run(limit);
    db.prepare(`UPDATE query_windows SET max_alerts=?`).run(limit);
  });
  tx();
  revalidatePath("/stocks/schedule");
  goSchedule({ flash: "default_saved" });
}

export async function windowToggleAction(fd: FormData): Promise<void> {
  const fd2 = new FormData();
  for (const [k, v] of fd.entries()) fd2.set(k, String(v));
  fd2.set("action", str(fd, "toggle"));
  await windowSaveAction(fd2);
}

export async function windowDeleteAction(fd: FormData): Promise<void> {
  const fd2 = new FormData();
  for (const [k, v] of fd.entries()) fd2.set(k, String(v));
  fd2.set("action", "delete");
  await windowSaveAction(fd2);
}

// —— 固定时间点（scheduler.go scheduleAdd/scheduleUpdate）——
export async function scheduleAddAction(fd: FormData): Promise<void> {
  const db = getDB();
  const t = parseClock(str(fd, "time"));
  if (t === null) goSchedule({ error: "时间必须为 HH:MM" });
  try {
    db.prepare(`INSERT INTO schedules(hour,minute) VALUES(?,?)`).run(Math.floor(t / 60), t % 60);
  } catch {
    goSchedule({ error: "时间已存在或存储失败" });
  }
  revalidatePath("/stocks/schedule");
  goSchedule({ flash: "schedule_added" });
}

export async function scheduleUpdateAction(fd: FormData): Promise<void> {
  const db = getDB();
  const id = str(fd, "id");
  const action = str(fd, "action");
  let flash: string;
  if (action === "time") {
    flash = "schedule_saved";
    const t = parseClock(str(fd, "time"));
    if (t === null) goSchedule({ error: "时间必须为 HH:MM" });
    try {
      db.prepare(`UPDATE schedules SET hour=?,minute=? WHERE id=?`).run(Math.floor(t / 60), t % 60, id);
    } catch {
      goSchedule({ error: "时间已存在或存储失败" });
    }
  } else if (action === "enable") {
    flash = "schedule_enabled";
    db.prepare(`UPDATE schedules SET enabled=1 WHERE id=?`).run(id);
  } else if (action === "disable") {
    flash = "schedule_disabled";
    db.prepare(`UPDATE schedules SET enabled=0 WHERE id=?`).run(id);
  } else if (action === "delete") {
    flash = "schedule_deleted";
    db.prepare(`DELETE FROM schedules WHERE id=?`).run(id);
  } else {
    redirect("/stocks/error/404");
  }
  revalidatePath("/stocks/schedule");
  goSchedule({ flash });
}

// —— 时区（scheduler.go zonePost）——
export async function zoneAction(fd: FormData): Promise<void> {
  const db = getDB();
  const name = str(fd, "timezone");
  const current = timezoneValue(db);
  if (name !== current) {
    const active = activeWindow(db, new Date(), current);
    if (active) goSchedule({ error: "当前处于查询时段内，请在时段结束后修改时区。" });
  }
  if (!validTimezone(name)) goSchedule({ error: "不支持该时区" });
  db.prepare(`UPDATE settings SET timezone=? WHERE id=1`).run(name);
  revalidatePath("/stocks/schedule");
  goSchedule({ flash: "zone_saved" });
}

// —— 备份恢复（config_backup.go restoreConfig 的导入校验部分）——
export async function restoreConfigAction(fd: FormData): Promise<void> {
  const db = getDB();
  if (str(fd, "confirm") !== "restore") {
    goSettings({ error: "请勾选确认覆盖当前配置" });
  }
  const file = fd.get("backup");
  if (!(file instanceof File)) goSettings({ error: "请选择 JSON 配置备份文件" });
  const data = await file.text();
  if (data.length > 2 << 20) goSettings({ error: "备份文件读取失败或超过 2 MiB" });
  const backupModule = await import("@/modules/stocks/backup");
  type ConfigBackup = import("@/modules/stocks/backup").ConfigBackup;
  let b: ConfigBackup;
  try {
    b = JSON.parse(data) as ConfigBackup;
  } catch {
    goSettings({ error: "备份 JSON 格式无效或含不支持的字段" });
  }
  try {
    backupModule.validateConfig(b);
  } catch (e) {
    goSettings({ error: e instanceof Error ? e.message : "备份校验失败" });
  }
  let proxyLatency = "";
  let testedAt = "";
  if (b.settings.proxy_url !== "") {
    try {
      proxyLatency = await testProxy(b.settings.proxy_url);
      testedAt = nowText();
    } catch (e) {
      goSettings({ error: `备份中的代理测试失败：${e instanceof Error ? e.message : "未知错误"}` });
    }
  }
  const { currentRunningID } = await import("@/modules/stocks/run");
  if (currentRunningID() !== 0) goSettings({ error: "查询仍在运行，请等本轮结束后恢复配置。" });
  try {
    backupModule.importConfig(db, b, proxyLatency, testedAt);
  } catch (e) {
    goSettings({ error: e instanceof Error ? e.message : "恢复失败" });
  }
  revalidatePath("/stocks/settings");
  revalidatePath("/");
  goSettings({ result: "restored" });
}
