import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sendBark } from "../../src/modules/stocks/notify.ts";

test("Bark resolves localhost and sends to a local mock server", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/push");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: 200, message: "success" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address() as { port: number };
    const result = await sendBark({ URL: `http://localhost:${address.port}`, Key: "test-only", Local: true }, "test", "test", "");
    assert.equal(result.status, "成功", result.error);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});
