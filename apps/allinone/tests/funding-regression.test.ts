import assert from "node:assert/strict";
import { test } from "node:test";
import { openFundingDB } from "../src/lib/funding/db.ts";
import { FundingStore } from "../src/lib/funding/store.ts";
import { fundingRequest } from "../src/lib/funding/api.ts";
import type {
  Account,
  Batch,
  Transfer,
  Goal,
} from "../src/lib/funding/types.ts";

function setup() {
  const db = openFundingDB();
  const store = new FundingStore(db);
  const bank = store.mutate("POST", "accounts", undefined, undefined, {
    name: "汇丰",
    kind: "bank",
  }) as Account;
  const broker = store.mutate("POST", "accounts", undefined, undefined, {
    name: "券商 A",
    kind: "broker",
  }) as Account;
  const batch = store.mutate("POST", "batches", undefined, undefined, {
    accountId: bank.id,
    name: "香港资金",
    currency: "HKD",
    amount: "3000000",
    sourceStatus: "verified",
  }) as Batch;
  return { db, store, bank, broker, batch };
}

test("confirmed creation, actual receipts and partial bank funds share one accounting path", () => {
  const { db, store, bank, broker, batch } = setup();
  try {
    assert.equal(batch.sourceStatus, "verified");
    const input = {
      kind: "broker",
      fromAccountId: bank.id,
      toAccountId: broker.id,
      currency: "HKD",
      amount: "2000000",
      receivedAmount: "1999900",
      status: "confirmed",
      occurredAt: "2026-06-01",
      confirmedAt: "2026-06-02",
      allocations: [{ batchId: batch.id, amount: "2000000" }],
    };
    const deposit = store.mutate(
      "POST",
      "transfers",
      undefined,
      undefined,
      input,
      "confirmed-deposit",
    ) as Transfer;
    assert.equal(deposit.status, "confirmed");
    assert.equal(store.summary().currencies[0].brokerConfirmed, "1999900");
    assert.equal(store.summary().currencies[0].bankAvailable, "1000000");
    assert.deepEqual(
      store.mutate(
        "POST",
        "transfers",
        undefined,
        undefined,
        input,
        "confirmed-deposit",
      ),
      deposit,
    );
    const pending = store.mutate("POST", "transfers", undefined, undefined, {
      ...input,
      amount: "1000000",
      receivedAmount: "1000000",
      status: "pending",
      allocations: [{ batchId: batch.id, amount: "1000000" }],
    }) as Transfer;
    store.mutate("POST", "transfers", pending.id, "confirm", {
      receivedAmount: "999900",
      confirmedAt: "2026-06-03",
    });
    assert.equal(store.summary().currencies[0].brokerConfirmed, "2999800");
    assert.equal(store.summary().currencies[0].inTransit, "0");
  } finally {
    db.close();
  }
});

test("historical source attachment and correction do not double-count confirmed deposits", () => {
  const { db, store, bank, broker, batch } = setup();
  try {
    const input = {
      kind: "broker",
      historical: true,
      toAccountId: broker.id,
      currency: "HKD",
      amount: "2000000",
      status: "confirmed",
      occurredAt: "2026-06-01",
    };
    const t = store.mutate(
      "POST",
      "transfers",
      undefined,
      undefined,
      input,
    ) as Transfer;
    const allocated = store.mutate("POST", "transfers", t.id, "allocations", {
      fromAccountId: bank.id,
      allocations: [{ batchId: batch.id, amount: "2000000" }],
    }) as Transfer;
    assert.equal(store.summary().currencies[0].brokerConfirmed, "2000000");
    const corrected = store.mutate("POST", "transfers", t.id, "correct", {
      ...allocated,
      receivedAmount: "1999900",
      status: "confirmed",
    }) as Transfer;
    assert.equal(corrected.correctionOf, t.id);
    assert.equal(store.summary().currencies[0].brokerConfirmed, "1999900");
    assert.equal(store.batches()[0].availableAmount, "1000000");
  } finally {
    db.close();
  }
});

test("goals respect account/date scope and reject impossible dates and enum objects", () => {
  const { db, store, bank, broker, batch } = setup();
  try {
    const other = store.mutate("POST", "accounts", undefined, undefined, {
      name: "券商 B",
      kind: "broker",
    }) as Account;
    const goal = store.mutate("POST", "goals", undefined, undefined, {
      accountId: broker.id,
      currency: "HKD",
      amount: "10000",
      floorAmount: "8000",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    }) as Goal;
    const t = store.mutate("POST", "transfers", undefined, undefined, {
      kind: "broker",
      historical: true,
      toAccountId: other.id,
      currency: "HKD",
      amount: "10000",
      status: "confirmed",
      occurredAt: "2026-06-01",
    }) as Transfer;
    assert.equal(
      store.summary().goals.find((g) => g.id === goal.id)?.actualAmount,
      "0",
    );
    assert.equal(store.summary().currencies[0].remainingAmount, "10000");
    assert.throws(() =>
      store.mutate("POST", "transfers", t.id, "verify", {
        pathStatus: ["verified"],
      }),
    );
    assert.throws(() =>
      store.mutate("POST", "batches", batch.id, "verify", {
        sourceStatus: ["verified"],
      }),
    );
    assert.throws(() =>
      store.mutate("POST", "batches", undefined, undefined, {
        accountId: bank.id,
        currency: "HKD",
        amount: "100",
        occurredAt: "2026-02-30",
      }),
    );
  } finally {
    db.close();
  }
});

test("optimistic edits reject stale versions and audit captures before/after and source", () => {
  const { db, store, bank } = setup();
  try {
    const input = { name: "汇丰香港", expectedUpdatedAt: bank.updatedAt };
    const edited = store.mutate(
      "PATCH",
      "accounts",
      bank.id,
      undefined,
      input,
      "edit",
      "assistant",
    ) as Account;
    assert.notEqual(edited.updatedAt, bank.updatedAt);
    assert.deepEqual(
      store.mutate(
        "PATCH",
        "accounts",
        bank.id,
        undefined,
        input,
        "edit",
        "assistant",
      ),
      edited,
    );
    assert.throws(() =>
      store.mutate("PATCH", "accounts", bank.id, undefined, {
        name: "旧页面修改",
        expectedUpdatedAt: bank.updatedAt,
      }),
    );
    const change = store.changes().at(-1)!;
    assert.equal(change.source, "assistant");
    assert.equal((change.before as Account).name, "汇丰");
    assert.equal((change.data as Account).name, "汇丰香港");
  } finally {
    db.close();
  }
});

test("HTTP API supports unauthenticated local JSON, rejects cross-site writes and exposes spec", async () => {
  const db = openFundingDB();
  globalThis.__fundingSqlite = db;
  try {
    const url = "http://localhost:3000/api/funding/v1/accounts";
    const write = (headers: Record<string, string>) =>
      new Request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "测试银行", kind: "bank" }),
      });
    assert.equal(
      (
        await fundingRequest(
          write({
            "content-type": "application/json",
            origin: "https://other.example",
          }),
          ["accounts"],
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fundingRequest(write({ "content-type": "text/plain" }), [
          "accounts",
        ])
      ).status,
      415,
    );
    const response = await fundingRequest(
      write({
        "content-type": "application/json",
        "X-Funding-Source": "assistant",
      }),
      ["accounts"],
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, "测试银行");
    const spec = await fundingRequest(
      new Request("http://localhost:3000/api/funding/v1/openapi.json"),
      ["openapi.json"],
    );
    assert.equal(spec.status, 200);
    assert.equal((await spec.json()).openapi, "3.1.0");
  } finally {
    globalThis.__fundingSqlite = undefined;
    db.close();
  }
});
