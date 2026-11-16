import { revalidatePath } from "next/cache";
import {
  createReminder, deleteReminder, getReminder, getRemindersDB, listReminderPage,
  MAX_TEXT_LENGTH, normalizeSchedule, removeAttachmentDir, updateReminder,
  type ReminderInput, type ScheduleInput,
} from "./store";

class APIError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** Shared JSON error handling for the private-network API. */
async function remindersAPI(action: () => Promise<Response> | Response): Promise<Response> {
  try { return await action(); }
  catch (error) {
    if (error instanceof APIError) return json({ error: error.message }, error.status);
    console.error("Reminders API failed", error);
    return json({ error: "Internal server error" }, 500);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new APIError(400, "Expected a JSON object");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new APIError(400, "Unknown field");
}

async function input(request: Request, creating: boolean): Promise<Partial<ReminderInput>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new APIError(415, "Content-Type must be application/json");
  }
  // Bound streamed bodies as well as bodies with Content-Length.
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 65536) { await reader.cancel(); throw new APIError(413, "JSON body exceeds 64 KiB"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new APIError(400, "Invalid JSON"); }
  const body = object(parsed);
  keys(body, ["text", "enabled", "schedules"]);
  if (!creating && Object.keys(body).length === 0) throw new APIError(400, "No fields to update");
  if (creating || "text" in body) {
    if (typeof body.text !== "string" || !body.text.trim() || body.text.trim().length > MAX_TEXT_LENGTH) {
      throw new APIError(400, `text must contain 1–${MAX_TEXT_LENGTH} characters`);
    }
  }
  if ("enabled" in body && typeof body.enabled !== "boolean") throw new APIError(400, "enabled must be boolean");
  if ("schedules" in body) {
    if (!Array.isArray(body.schedules) || body.schedules.length > 100) throw new APIError(400, "schedules must be an array of at most 100 entries");
    for (const raw of body.schedules) {
      const s = object(raw);
      const fields = s.kind === "once" ? ["at"] : s.kind === "interval" ? ["startAt", "intervalSeconds", "total"] : s.kind === "cron" ? ["cron"] : null;
      if (!fields) throw new APIError(400, "Invalid schedule kind");
      keys(s, ["kind", "enabled", ...fields]);
      if ("enabled" in s && typeof s.enabled !== "boolean") throw new APIError(400, "schedule enabled must be boolean");
      for (const field of fields) {
        const numeric = field === "intervalSeconds" || field === "total";
        if (typeof s[field] !== (numeric ? "number" : "string")) throw new APIError(400, `Invalid schedule ${field}`);
      }
      try { normalizeSchedule(s as ScheduleInput, Date.now()); }
      catch (error) { throw new APIError(400, error instanceof Error ? error.message : "Invalid schedule"); }
    }
  }
  return body as Partial<ReminderInput>;
}

function integer(value: string, label: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value)) throw new APIError(400, `Invalid ${label}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new APIError(400, `Invalid ${label}`);
  return n;
}

export function list(request: Request) {
  return remindersAPI(() => {
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) {
      if (!["limit", "offset", "q", "enabled"].includes(key) || params.getAll(key).length !== 1) throw new APIError(400, "Invalid query parameter");
    }
    const enabled = params.get("enabled");
    if (enabled !== null && enabled !== "true" && enabled !== "false") throw new APIError(400, "enabled must be true or false");
    const q = params.get("q") ?? "";
    if (q.length > MAX_TEXT_LENGTH) throw new APIError(400, "Search query too long");
    const options = {
      limit: integer(params.get("limit") ?? "20", "limit", 1, 100),
      offset: integer(params.get("offset") ?? "0", "offset", 0),
      q, enabled: enabled === null ? undefined : enabled === "true",
    };
    return json(listReminderPage(getRemindersDB(), options));
  });
}

function revalidate(): void {
  revalidatePath("/reminders");
  revalidatePath("/");
}

export function create(request: Request) {
  return remindersAPI(async () => {
    const body = await input(request, true);
    const db = getRemindersDB();
    const id = createReminder(db, body as ReminderInput);
    revalidate();
    return json(getReminder(db, id), 201, { Location: `/api/reminders/${id}` });
  });
}

export function detail(request: Request, rawId: string, operation: "get" | "patch" | "delete") {
  return remindersAPI(async () => {
    const id = integer(rawId, "id", 1);
    const body = operation === "patch" ? await input(request, false) : undefined;
    const db = getRemindersDB();
    const response = db.transaction(() => {
      const existing = getReminder(db, id);
      if (!existing) throw new APIError(404, "Reminder not found");
      if (operation === "delete") { deleteReminder(db, id); return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); }
      if (body) updateReminder(db, id, body);
      return json(body ? getReminder(db, id) : existing);
    }).immediate();
    if (operation === "delete") removeAttachmentDir(id);
    if (operation !== "get") revalidate();
    return response;
  });
}
