import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { checkStockFields, parseTarget } from "./levels";
import { decString, parseDecimal } from "./decimal";

export class StocksAPIError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const bad = (message: string): never => { throw new StocksAPIError(400, message); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("Expected an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(`Unknown field: ${key}`);
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string") return bad(`${name} must be a string`);
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") return bad("enabled must be a boolean");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return bad(`Expected integer ${min}..${max}`);
  return value;
}
function validated<T>(fn: () => T): T {
  try { return fn(); } catch (e) { if (e instanceof StocksAPIError) throw e; return bad(e instanceof Error ? e.message : "Invalid input"); }
}
function symbolOf(symbol: string) { return validated(() => checkStockFields(symbol, "")); }
function targetOf(input: unknown): { target: string; range?: string } {
  if (typeof input === "string") return { target: validated(() => parseTarget(input)) };
  const range = object(input);
  keys(range, ["min", "max"]);
  const min = validated(() => parseTarget(text(range.min, "min")));
  const max = validated(() => parseTarget(text(range.max, "max")));
  const units = (s: string) => { const d = parseDecimal(s)!; return d.mag * 10n ** BigInt(d.exp + 4); };
  const lo = units(min), hi = units(max);
  if (lo > hi) bad("Range min must not exceed max");
  if ((lo + hi) % 2n !== 0n) bad("Range midpoint cannot be represented with at most 4 decimals");
  return { target: validated(() => parseTarget(decString({ sign: 1, mag: (lo + hi) / 2n, exp: -4 }))), range: `[range ${min}..${max}]` };
}

type LevelConfig = { id: number; uid: string; side: string; target: string; note: string; enabled: boolean; mode: string; cooldown: number; max_alerts: number };
type StockRow = { id: number; symbol: string; note: string; enabled: number; reference_buy: string };
function readConfig(db: Database.Database, symbol: string) {
  const row = db.prepare("SELECT id,symbol,note,enabled,reference_buy FROM stocks WHERE symbol=?").get(symbol) as StockRow | undefined;
  if (!row) throw new StocksAPIError(404, "Stock not found");
  const levels = (db.prepare("SELECT id,uid,side,target,note,enabled,mode,cooldown,max_alerts FROM levels WHERE stock_id=? ORDER BY id").all(row.id) as Array<Omit<LevelConfig, "enabled"> & { enabled: number }>).map(l => ({ ...l, enabled: l.enabled === 1 }));
  const config = { ...row, enabled: row.enabled === 1, levels };
  const revision = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  return { ...config, revision };
}
export function getStockConfig(db: Database.Database, symbol: string) {
  return db.transaction(() => readConfig(db, symbolOf(symbol)))();
}
export function listStockConfigs(db: Database.Database) {
  return db.transaction(() => {
    const rows = db.prepare("SELECT symbol FROM stocks ORDER BY symbol").all() as Array<{ symbol: string }>;
    return rows.map(({ symbol }) => {
      const { levels, ...stock } = readConfig(db, symbol);
      return { ...stock, level_count: levels.length };
    });
  })();
}

/** Explicit merge: omitted fields/levels are preserved. review triggers at <= target. */
export function patchStockConfig(db: Database.Database, symbol: string, input: unknown) {
  const body = object(input);
  keys(body, ["revision", "note", "enabled", "reference_buy", "levels", "delete_level_ids"]);
  return db.transaction(() => {
    const current = readConfig(db, symbolOf(symbol));
    if (body.revision !== undefined && text(body.revision, "revision") !== current.revision) throw new StocksAPIError(409, "Configuration revision conflict");
    const note = body.note === undefined ? current.note : text(body.note, "note").trim();
    validated(() => checkStockFields(current.symbol, note));
    const enabled = body.enabled === undefined ? current.enabled : bool(body.enabled);
    const reference = body.reference_buy === undefined ? current.reference_buy : text(body.reference_buy, "reference_buy");
    const referenceBuy = reference === "" ? "" : validated(() => parseTarget(reference));
    if (body.levels !== undefined && !Array.isArray(body.levels)) bad("levels must be an array");
    if (body.delete_level_ids !== undefined && !Array.isArray(body.delete_level_ids)) bad("delete_level_ids must be an array");
    const deleted = new Set<number>();
    for (const raw of (body.delete_level_ids ?? []) as unknown[]) {
      const id = integer(raw, 1, Number.MAX_SAFE_INTEGER);
      if (deleted.has(id)) bad("Duplicate deletion id");
      if (!current.levels.some(l => l.id === id)) bad("Deletion id does not belong to this stock");
      deleted.add(id);
    }
    const touched = new Set<number>();
    const uids = new Set<string>();
    for (const raw of (body.levels ?? []) as unknown[]) {
      const level = object(raw);
      keys(level, ["id", "uid", "side", "target", "note", "enabled", "mode", "cooldown", "max_alerts"]);
      const id = level.id === undefined ? undefined : integer(level.id, 1, Number.MAX_SAFE_INTEGER);
      const old = id === undefined ? undefined : current.levels.find(l => l.id === id);
      if (id !== undefined && !old) bad("Level id does not belong to this stock");
      if (id !== undefined && (touched.has(id) || deleted.has(id))) bad("Duplicate or conflicting level id");
      if (id !== undefined) touched.add(id);
      const uid = level.uid === undefined ? old?.uid ?? randomUUID() : text(level.uid, "uid");
      if (level.uid !== undefined && (!/^[A-Za-z0-9._:-]{1,128}$/.test(uid))) bad("Invalid uid");
      if (old && uid !== old.uid) bad("Existing level uid is immutable");
      if (uid && uids.has(uid)) bad("Duplicate uid");
      if (uid) uids.add(uid);
      if (!old && level.uid === undefined && body.revision === undefined) throw new StocksAPIError(428, "Creating a level requires uid or revision");
      const side = level.side ?? old?.side;
      if (side !== "buy" && side !== "sell" && side !== "review") bad("side must be buy, sell or review");
      const target = targetOf(level.target ?? old?.target);
      let levelNote = level.note === undefined ? old?.note ?? "" : text(level.note, "note").trim();
      if (target.range && !levelNote.endsWith(target.range)) levelNote = [levelNote, target.range].filter(Boolean).join(" ");
      if (levelNote.length > 200) bad("Level note including range must be at most 200 characters");
      const mode = level.mode ?? old?.mode ?? "once";
      if (mode !== "once" && mode !== "repeat") bad("Invalid mode");
      const next = { uid, side, target: target.target, note: levelNote,
        enabled: level.enabled === undefined ? old?.enabled ?? true : bool(level.enabled), mode,
        cooldown: integer(level.cooldown ?? old?.cooldown ?? 60, 1, 10080),
        max_alerts: integer(level.max_alerts ?? old?.max_alerts ?? 0, 0, 1000) };
      if (!old && level.uid !== undefined) {
        const existing = db.prepare("SELECT id,stock_id FROM levels WHERE uid=?").get(uid) as { id: number; stock_id: number } | undefined;
        if (existing) {
          const match = current.levels.find(l => l.id === existing.id);
          if (existing.stock_id !== current.id || !match || deleted.has(existing.id) || touched.has(existing.id) || Object.entries(next).some(([k, v]) => match[k as keyof LevelConfig] !== v)) throw new StocksAPIError(409, "uid already exists with different configuration");
          touched.add(existing.id);
          continue;
        }
      }
      const args = [next.side, next.target, next.note, Number(next.enabled), next.mode, next.cooldown, next.max_alerts];
      if (old) db.prepare("UPDATE levels SET side=?,target=?,note=?,enabled=?,mode=?,cooldown=?,max_alerts=? WHERE id=? AND stock_id=?").run(...args, old.id, current.id);
      else db.prepare("INSERT INTO levels(side,target,note,enabled,mode,cooldown,max_alerts,uid,stock_id) VALUES(?,?,?,?,?,?,?,?,?)").run(...args, uid, current.id);
    }
    for (const id of deleted) db.prepare("DELETE FROM levels WHERE id=? AND stock_id=?").run(id, current.id);
    db.prepare("UPDATE stocks SET note=?,enabled=?,reference_buy=? WHERE id=?").run(note, Number(enabled), referenceBuy, current.id);
    return readConfig(db, current.symbol);
  }).immediate();
}

export function stocksAPIResponse(action: () => unknown): Response {
  try { return Response.json(action(), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) {
    return Response.json({ error: e instanceof StocksAPIError ? e.message : "Internal server error" }, { status: e instanceof StocksAPIError ? e.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}
