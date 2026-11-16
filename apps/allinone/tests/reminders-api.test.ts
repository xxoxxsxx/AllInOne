import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET as list, POST as create } from "../src/app/api/reminders/route.ts";
import { GET, PATCH, DELETE } from "../src/app/api/reminders/[id]/route.ts";
import { applyScheduleUpdates, getRemindersDB, resetRemindersDBForTest, saveReminderImage, attachmentDir, setScheduleRetry } from "../src/lib/reminders/store.ts";

function request(method = "GET", body?: unknown, query = "") {
  return new Request(`http://localhost/api/reminders${query}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const context = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

test("reminders HTTP API CRUD, validation and schedule preservation without credentials", async (t) => {
  const previousDir = process.env.DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reminders-api-"));
  process.env.DATA_DIR = dir;
  resetRemindersDBForTest();
  try {
    const empty = await list(request());
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { items: [], total: 0, limit: 20, offset: 0 });
    const created = await create(request("POST", { text: "Pay 100% bill", enabled: false, schedules: [
      { kind: "interval", startAt: "2030-01-01T00:00:00Z", intervalSeconds: 60, total: 5 },
      { kind: "once", at: "2030-01-01T00:00:00Z" },
      { kind: "cron", cron: "0 9 * * *" },
    ] }));
    assert.equal(created.status, 201);
    const original = await created.json();
    const id = original.id;
    assert.equal(created.headers.get("location"), `/api/reminders/${id}`);
    const db = getRemindersDB();
    const scheduleId = original.schedules[0].id;
    applyScheduleUpdates(db, [{ id: scheduleId, next_at: Date.parse("2030-01-01T00:02:00Z"), sent: 2, missed: true }]);
    setScheduleRetry(db, scheduleId, { retryAt: Date.parse("2030-01-01T00:03:00Z"), retryCount: 2, scheduledAt: Date.parse("2030-01-01T00:01:00Z"), catchup: true });
    saveReminderImage(db, id, Buffer.from([137,80,78,71,13,10,26,10]), "image/png", "bill.png");
    const before = await (await GET(request(), context(id))).json();
    const patched = await PATCH(request("PATCH", { text: "Pay 100% updated" }), context(id));
    assert.equal(patched.status, 200);
    const after = await patched.json();
    assert.equal(after.enabled, false);
    assert.deepEqual(after.schedules, before.schedules);
    assert.deepEqual(after.images, before.images);
    for (const enabled of [true, false]) {
      const toggled = await (await PATCH(request("PATCH", { enabled }), context(id))).json();
      assert.equal(toggled.enabled, enabled);
      assert.deepEqual(toggled.schedules, before.schedules);
    }
    await create(request("POST", { text: "Another reminder" }));
    const pageResponse = await list(request("GET", undefined, "?q=100%25&enabled=false&limit=1&offset=0"));
    assert.equal(pageResponse.headers.get("cache-control"), "no-store");
    const page = await pageResponse.json();
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, id);
    assert.equal("schedules" in page.items[0], false);
    assert.equal("images" in page.items[0], false);
    assert.equal("completed" in page.items[0], false);
    const secondPage = await (await list(request("GET", undefined, "?limit=1&offset=1"))).json();
    assert.equal(secondPage.total, 2);
    assert.equal(secondPage.items[0].id, id);
    for (const query of ["?limit=0", "?limit=101", "?offset=-1", "?enabled=1", "?limit=1&limit=2", "?completed=true"]) assert.equal((await list(request("GET", undefined, query))).status, 400);
    for (const body of [null, [], {}, { text: "" }, { enabled: "false" }, { completed: true }, { schedules: null }, { schedules: [{ kind: "once", at: 1 }] }, { schedules: [{ kind: "interval", startAt: "2030-01-01", intervalSeconds: "60", total: 3 }] }, { text: "must not save", schedules: [{ kind: "cron", cron: "invalid" }] }]) {
      assert.equal((await PATCH(request("PATCH", body), context(id))).status, 400);
    }
    assert.equal((await create(request("POST", { enabled: true }))).status, 400);
    assert.equal((await create(new Request("http://localhost/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).status, 400);
    assert.equal((await create(new Request("http://localhost/api/reminders", { method: "POST", body: "{}" }))).status, 415);
    assert.equal((await create(request("POST", { text: "x".repeat(65536) }))).status, 413);
    assert.equal((await GET(request(), context("1x"))).status, 400);
    assert.equal((await GET(request(), context(9999))).status, 404);
    const unchanged = await (await GET(request(), context(id))).json();
    assert.equal(unchanged.text, "Pay 100% updated");
    assert.deepEqual(unchanged.schedules, before.schedules);
    const replaced = await (await PATCH(request("PATCH", { schedules: [{ kind: "once", at: "2031-01-01T00:00:00Z" }] }), context(id))).json();
    assert.equal(replaced.schedules.length, 1);
    assert.notEqual(replaced.schedules[0].id, scheduleId);
    assert.equal(replaced.schedules[0].sent, 0);
    assert.equal((await DELETE(request("DELETE"), context(id))).status, 204);
    assert.equal(fs.existsSync(attachmentDir(id)), false);
    assert.equal((await GET(request(), context(id))).status, 404);
    assert.equal((await PATCH(request("PATCH", { enabled: true }), context(id))).status, 404);
    assert.equal((await DELETE(request("DELETE"), context(id))).status, 404);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM reminder_schedules WHERE reminder_id=?").get(id) as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM reminder_images WHERE reminder_id=?").get(id) as { n: number }).n, 0);

    const cleanupItem = await (await create(request("POST", { text: "Cleanup failure" }))).json();
    saveReminderImage(db, cleanupItem.id, Buffer.from([137,80,78,71,13,10,26,10]), "image/png", "image.png");
    const rm = t.mock.method(fs, "rmSync", () => { throw new Error("Simulated cleanup failure"); });
    const log = t.mock.method(console, "error", () => {});
    try {
      assert.equal((await DELETE(request("DELETE"), context(cleanupItem.id))).status, 204);
      assert.equal((await GET(request(), context(cleanupItem.id))).status, 404);
      assert.equal(log.mock.callCount(), 1);
    } finally {
      rm.mock.restore();
      log.mock.restore();
    }

    // Unexpected storage failures stay generic and do not leave partial writes.
    db.exec("CREATE TRIGGER reject_api_insert BEFORE INSERT ON reminders BEGIN SELECT RAISE(ABORT, 'private database failure'); END");
    const errors = t.mock.method(console, "error", () => {});
    try {
      const failed = await create(request("POST", { text: "Must roll back" }));
      assert.equal(failed.status, 500);
      assert.equal(failed.headers.get("cache-control"), "no-store");
      assert.deepEqual(await failed.json(), { error: "Internal server error" });
      assert.equal((await (await list(request("GET", undefined, "?q=Must"))).json()).total, 0);
    } finally {
      errors.mock.restore();
      db.exec("DROP TRIGGER reject_api_insert");
    }
  } finally {
    resetRemindersDBForTest();
    if (previousDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
