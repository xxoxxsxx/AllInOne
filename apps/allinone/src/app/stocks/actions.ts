"use server";

// 股票与档位的 Server Actions（web.go / level_web.go 的表单处理语义）。
// 所有变更操作走 Server Actions；错误以 query 参数 ?error=... 回显，成功用 ?flash=...。

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getDB } from "@/modules/stocks/store";
import { checkStockFields, parseTarget } from "@/modules/stocks/levels";

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

function goHome(params: Record<string, string>): never {
  // 原版行为：操作后回到监控列表（/stocks），flash/error 经查询串展示。
  const q = new URLSearchParams(params);
  redirect(`/stocks${q.toString() ? `?${q}` : ""}`);
}

function goStock(id: string | number, params: Record<string, string>, hash?: string): never {
  const q = new URLSearchParams(params);
  redirect(`/stocks/${id}${q.toString() ? `?${q}` : ""}${hash ? `#${hash}` : ""}`);
}


// —— 股票 ——
export async function stockAddAction(fd: FormData): Promise<void> {
  const db = getDB();
  let symbol: string;
  let note: string;
  try {
    symbol = checkStockFields(str(fd, "symbol"), str(fd, "note"));
    note = str(fd, "note").trim();
  } catch (e) {
    goHome({ error: e instanceof Error ? e.message : "输入无效" });
  }
  try {
    const res = db.prepare(`INSERT INTO stocks(symbol,note,enabled) VALUES(?,?,1)`).run(symbol, note);
    const id = Number(res.lastInsertRowid);
    revalidatePath("/");
    goStock(id, { flash: "stock_added" }, "add-level");
  } catch {
    goHome({ error: "添加失败：代码已存在或数据库不可用" });
  }
}

export async function stockUpdateAction(fd: FormData): Promise<void> {
  const db = getDB();
  const id = str(fd, "id");
  let symbol: string;
  let note: string;
  let enabled: boolean;
  try {
    symbol = checkStockFields(str(fd, "symbol"), str(fd, "note"));
    note = str(fd, "note").trim();
    enabled = str(fd, "enabled") === "1";
  } catch (e) {
    goStock(id, { error: e instanceof Error ? e.message : "输入无效" }, "stock-settings");
  }
  const old = db.prepare(`SELECT symbol FROM stocks WHERE id=?`).get(id) as { symbol: string } | undefined;
  if (!old) redirect("/stocks/error/404");
  try {
    db.prepare(`UPDATE stocks SET symbol=?,note=?,enabled=? WHERE id=?`).run(symbol, note, enabled ? 1 : 0, id);
    if (old.symbol !== symbol) {
      // 修改代码会重新启用所有档位提醒（generation+1、清空已提醒状态）。
      db.prepare(`UPDATE levels SET generation=generation+1,alerted_generation=NULL,last_attempt='' WHERE stock_id=?`).run(id);
    }
  } catch {
    goStock(id, { error: "更新失败：代码已存在或数据库不可用" }, "stock-settings");
  }
  revalidatePath(`/stocks/${id}`);
  revalidatePath("/");
  goStock(id, { flash: "stock_saved" }, "stock-settings");
}

export async function stockDeleteAction(fd: FormData): Promise<void> {
  const db = getDB();
  const id = str(fd, "id");
  const stock = db.prepare(`SELECT symbol FROM stocks WHERE id=?`).get(id) as { symbol: string } | undefined;
  if (!stock) redirect("/stocks/error/404");
  if (str(fd, "confirm").trim().toUpperCase() !== stock.symbol) {
    goStock(id, { error: "请输入股票代码确认删除" }, "delete-stock");
  }
  db.prepare(`DELETE FROM stocks WHERE id=?`).run(id);
  revalidatePath("/");
  goHome({ flash: "stock_deleted" });
}

export async function stockReferenceAction(fd: FormData): Promise<void> {
  const db = getDB();
  const id = str(fd, "id");
  let target: string;
  try {
    target = parseTarget(str(fd, "reference_buy"));
  } catch (e) {
    goHome({ error: e instanceof Error ? e.message : "参考价无效" });
  }
  const res = db.prepare(`UPDATE stocks SET reference_buy=? WHERE id=? AND EXISTS(SELECT 1 FROM levels WHERE stock_id=? AND side='buy' AND target=?)`)
    .run(target, id, id, target);
  if (Number(res.changes) === 0) {
    goHome({ error: "买入目标已变更，请刷新页面后重试" });
  }
  revalidatePath("/");
  goHome({ flash: "reference_saved" });
}

// —— 档位 ——
function levelFields(fd: FormData): { side: string; target: string; note: string; limit: number } {
  const side = str(fd, "side");
  if (side !== "buy" && side !== "sell") throw new Error("方向无效");
  const target = parseTarget(str(fd, "target"));
  const note = str(fd, "note").trim();
  if (note.length > 200) throw new Error("备注过长");
  const text = str(fd, "max_alerts").trim();
  let limit = 0;
  if (text !== "") {
    limit = Number(text);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("档位提醒上限须为 1～1000 次，或留空继承时段默认值");
    }
  }
  return { side, target, note, limit };
}

export async function levelAddAction(fd: FormData): Promise<void> {
  const db = getDB();
  const stockID = str(fd, "id");
  if (!db.prepare(`SELECT 1 FROM stocks WHERE id=?`).get(stockID)) redirect("/stocks/error/404");
  let fields;
  try {
    fields = levelFields(fd);
  } catch (e) {
    goStock(stockID, { error: e instanceof Error ? e.message : "输入无效" }, "add-level");
  }
  db.prepare(`INSERT INTO levels(stock_id,side,target,note,max_alerts,uid) VALUES(?,?,?,?,?,lower(hex(randomblob(16))))`)
    .run(stockID, fields.side, fields.target, fields.note, fields.limit);
  revalidatePath(`/stocks/${stockID}`);
  revalidatePath("/");
  goStock(stockID, { flash: "level_added" }, "add-level");
}

export async function levelUpdateAction(fd: FormData): Promise<void> {
  const db = getDB();
  const stockID = str(fd, "id");
  const levelID = str(fd, "level");
  let fields;
  try {
    fields = levelFields(fd);
  } catch (e) {
    goStock(stockID, { error: e instanceof Error ? e.message : "输入无效" }, `level-${levelID}`);
  }
  const res = db.prepare(`UPDATE levels SET side=?,target=?,note=?,max_alerts=? WHERE id=? AND stock_id=?`)
    .run(fields.side, fields.target, fields.note, fields.limit, levelID, stockID);
  if (Number(res.changes) === 0) redirect("/stocks/error/404");
  revalidatePath(`/stocks/${stockID}`);
  revalidatePath("/");
  goStock(stockID, { updated: levelID }, `level-${levelID}`);
}

export async function levelActionAction(fd: FormData): Promise<void> {
  const db = getDB();
  const stockID = str(fd, "id");
  const levelID = str(fd, "level");
  const action = str(fd, "action");
  let query: string;
  let flash: string;
  switch (action) {
    case "pause":
      query = `UPDATE levels SET enabled=0 WHERE id=? AND stock_id=?`;
      flash = "level_paused";
      break;
    case "enable":
      query = `UPDATE levels SET enabled=1 WHERE id=? AND stock_id=?`;
      flash = "level_enabled";
      break;
    case "rearm":
      query = `UPDATE levels SET enabled=1,generation=generation+1,alerted_generation=NULL,last_attempt='' WHERE id=? AND stock_id=?`;
      flash = "level_rearmed";
      break;
    case "delete":
      query = `DELETE FROM levels WHERE id=? AND stock_id=?`;
      flash = "level_deleted";
      break;
    default:
      redirect("/stocks/error/404");
  }
  const res = db.prepare(query).run(levelID, stockID);
  if (Number(res.changes) === 0) redirect("/stocks/error/404");
  revalidatePath(`/stocks/${stockID}`);
  revalidatePath("/");
  goStock(stockID, { flash }, "price-levels");
}

// —— 手动查询 ——
export async function startRunAction(): Promise<void> {
  const { startManualRun } = await import("@/modules/stocks/run");
  const { timezoneValue } = await import("@/modules/stocks/windows");
  const db = getDB();
  const result = startManualRun(db, timezoneValue(db));
  if (!result.ok) {
    goHome({ error: result.error });
  }
  revalidatePath("/");
  redirect(`/stocks/runs/${result.id}`);
}

// —— 添加股票弹窗（新增 Action，原有 Action 均未改动）——
// 原版 app.js 在 #stock-dialog 里 fetch POST /stocks 并按返回值就地处理：
// 「保存并继续添加」留在弹窗内（reset + toast），「保存并设置提醒」跳转
// /stocks/{id}?flash=stock_added#add-level。重定向型 stockAddAction 无法表达
// 「留在弹窗」的分支，故按任务约定新增一个不重定向、返回结果对象的 Action，
// 校验/入库与 stockAddAction 完全一致（checkStockFields + INSERT enabled=1）。
export async function stockAddOnceAction(
  fd: FormData,
): Promise<{ ok: true; id: number; symbol: string } | { ok: false; error: string }> {
  const db = getDB();
  try {
    const symbol = checkStockFields(str(fd, "symbol"), str(fd, "note"));
    const note = str(fd, "note").trim();
    const res = db.prepare(`INSERT INTO stocks(symbol,note,enabled) VALUES(?,?,1)`).run(symbol, note);
    revalidatePath("/");
    return { ok: true, id: Number(res.lastInsertRowid), symbol };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "添加失败：代码已存在或数据库不可用" };
  }
}
