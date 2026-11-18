import assert from "node:assert/strict";
import { test } from "node:test";
import { openFundingDB } from "../src/lib/funding/db.ts";
import { FundingStore } from "../src/lib/funding/store.ts";
import type {
  Account,
  Batch,
  Transfer,
  Goal,
} from "../src/lib/funding/types.ts";
function setup() {
  const db = openFundingDB();
  const s = new FundingStore(db);
  const create = <T>(
    c: "accounts" | "batches" | "transfers" | "goals",
    i: Record<string, unknown>,
    key?: string,
  ) => s.mutate("POST", c, undefined, undefined, i, key) as T;
  const a = create<Account>("accounts", { name: "Bank", kind: "bank" });
  const b = create<Account>("accounts", { name: "Bank 2", kind: "bank" });
  const broker = create<Account>("accounts", {
    name: "Broker",
    kind: "broker",
  });
  const batch = create<Batch>("batches", {
    accountId: a.id,
    currency: "CNY",
    amount: "10000",
  });
  return { db, s, create, a, b, broker, batch };
}
test("funding reserves cents, confirms bank arrivals, prevents duplicate/overspend and downstream void", () => {
  const { db, s, create, a, b, broker, batch } = setup();
  try {
    const input = {
      kind: "bank",
      fromAccountId: a.id,
      toAccountId: b.id,
      currency: "CNY",
      amount: "9000",
      feeAmount: "100",
      allocations: [{ batchId: batch.id, amount: "9100" }],
    };
    const t = create<Transfer>("transfers", input, "create");
    assert.deepEqual(create("transfers", input, "create"), t);
    assert.throws(() =>
      create("transfers", { ...input, amount: "8999" }, "create"),
    );
    assert.equal(
      s.batches().find((x) => x.id === batch.id)?.availableAmount,
      "900",
    );
    assert.throws(() => create("transfers", input));
    const confirmed = s.mutate(
      "POST",
      "transfers",
      t.id,
      "confirm",
      {},
      "confirm",
    ) as Transfer;
    assert.deepEqual(
      s.mutate("POST", "transfers", t.id, "confirm", {}, "confirm"),
      confirmed,
    );
    assert.throws(() => s.mutate("POST", "transfers", t.id, "confirm", {}));
    const deposit = create<Transfer>("transfers", {
      kind: "broker",
      fromAccountId: b.id,
      toAccountId: broker.id,
      currency: "CNY",
      amount: "9000",
      allocations: [{ batchId: confirmed.resultBatchId, amount: "9000" }],
    });
    assert.throws(() => s.mutate("POST", "transfers", t.id, "void", {}));
    assert.equal(s.summary().currencies[0].brokerConfirmed, "0");
    s.mutate("POST", "transfers", deposit.id, "confirm", {});
    assert.equal(s.summary().currencies[0].brokerConfirmed, "9000");
    s.mutate("POST", "transfers", deposit.id, "void", {});
    s.mutate("POST", "transfers", t.id, "void", {});
    assert.equal(
      s.batches().find((x) => x.id === batch.id)?.availableAmount,
      "10000",
    );
  } finally {
    db.close();
  }
});
test("funding exchange, historical sources, goals and correction rollback", () => {
  const { db, s, create, a, b, broker, batch } = setup();
  try {
    const fx = create<Transfer>("transfers", {
      kind: "exchange",
      fromAccountId: a.id,
      toAccountId: b.id,
      currency: "CNY",
      amount: "7000",
      receivedCurrency: "USD",
      receivedAmount: "1000",
      allocations: [{ batchId: batch.id, amount: "7000" }],
    });
    s.mutate("POST", "transfers", fx.id, "confirm", {});
    assert.equal(
      s.summary().currencies.find((c) => c.currency === "USD")?.bankAvailable,
      "1000",
    );
    const historical = create<Transfer>("transfers", {
      kind: "broker",
      historical: true,
      toAccountId: broker.id,
      currency: "CNY",
      amount: "2000",
    });
    s.mutate("POST", "transfers", historical.id, "confirm", {
      confirmedAt: "2026-05-01T12:00:00Z",
    });
    create<Goal>("goals", {
      name: "Goal",
      accountId: broker.id,
      currency: "CNY",
      amount: "3000",
      floorAmount: "1000",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });
    assert.equal(s.summary().goals[0].actualAmount, "2000");
    assert.equal(s.summary().goals[0].floorReached, true);
    assert.throws(() =>
      s.mutate("POST", "transfers", historical.id, "correct", {
        kind: "invalid",
      }),
    );
    assert.equal(s.get("transfers", historical.id).status, "confirmed");
    s.mutate("POST", "transfers", historical.id, "allocations", {
      fromAccountId: a.id,
      allocations: [{ batchId: batch.id, amount: "2000" }],
    });
    assert.equal(
      s.batches().find((x) => x.id === batch.id)?.availableAmount,
      "1000",
    );
    assert.throws(() =>
      s.mutate("POST", "transfers", historical.id, "allocations", {
        fromAccountId: a.id,
        allocations: [{ batchId: batch.id, amount: "2000" }],
      }),
    );
    s.mutate("POST", "transfers", historical.id, "verify", {
      pathStatus: "partial",
      pathNote: "receipt",
    });
    assert.equal(s.get("transfers", historical.id).pathStatus, "partial");
    assert.ok(s.changes().length > 10);
  } finally {
    db.close();
  }
});
test("funding validates exact integer amounts, duplicate allocations and currencies", () => {
  const { db, create, a, broker, batch } = setup();
  try {
    for (const amount of [1, "1.2", "-1", "01", "0"])
      assert.throws(() =>
        create("batches", { accountId: a.id, currency: "CNY", amount }),
      );
    assert.throws(() =>
      create("transfers", {
        kind: "broker",
        fromAccountId: a.id,
        toAccountId: broker.id,
        currency: "USD",
        amount: "100",
        allocations: [{ batchId: batch.id, amount: "100" }],
      }),
    );
    assert.throws(() =>
      create("transfers", {
        kind: "broker",
        fromAccountId: a.id,
        toAccountId: broker.id,
        currency: "CNY",
        amount: "200",
        allocations: [
          { batchId: batch.id, amount: "100" },
          { batchId: batch.id, amount: "100" },
        ],
      }),
    );
    const huge = create<Batch>("batches", {
      accountId: a.id,
      currency: "USD",
      amount: "900719925474099312345",
    });
    assert.equal(huge.amount, "900719925474099312345");
  } finally {
    db.close();
  }
});
