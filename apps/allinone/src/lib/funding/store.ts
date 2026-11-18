import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getFundingDB } from "./db";
import type {
  Account,
  Batch,
  Transfer,
  Goal,
  Change,
  Summary,
  Allocation,
} from "./types";
type Entities = {
  accounts: Account;
  batches: Batch;
  transfers: Transfer;
  goals: Goal;
};
export type Collection = keyof Entities;
type Input = Record<string, unknown>;
export class FundingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
function fail(message: string, status = 400): never {
  throw new FundingError(message, status);
}
function text(value: unknown, name: string, required = false): string {
  if (value === undefined && !required) return "";
  if (
    typeof value !== "string" ||
    value.length > 10000 ||
    (required && !value.trim())
  )
    fail(`${name} must be a nonempty string`);
  return value.trim();
}
function money(value: unknown, name = "amount", zero = false): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,29})$/.test(value) ||
    (!zero && BigInt(value) === BigInt(0))
  )
    fail(
      `${name} must be a ${zero ? "nonnegative" : "positive"} integer string in minor units`,
    );
  return value;
}
function currency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value))
    fail("currency must be a three-letter uppercase code");
  return value;
}
function date(value: unknown): string {
  if (value === undefined) return new Date().toISOString();
  const s = text(value, "date", true);
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      s,
    ) ||
    !Number.isFinite(Date.parse(s))
  )
    fail("date must be YYYY-MM-DD or an ISO timestamp");
  const day = s.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)
    fail("invalid calendar date");
  return s;
}
function nullableDate(value: unknown): string | null {
  return value == null || value === "" ? null : date(value);
}
function goalWindow(input: {
  startDate: string | null;
  endDate: string | null;
  floorAmount: string | null;
  amount: string;
}) {
  if (
    input.startDate &&
    input.endDate &&
    Date.parse(input.startDate) > Date.parse(input.endDate)
  )
    fail("goal startDate must precede endDate");
  if (input.floorAmount && BigInt(input.floorAmount) > BigInt(input.amount))
    fail("floorAmount exceeds goal amount");
}
function bool(value: unknown, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail("expected boolean");
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export class FundingStore {
  db: Database.Database;
  private operationSource = "api";
  constructor(db = getFundingDB()) {
    this.db = db;
  }
  list<K extends Collection>(collection: K): Entities[K][] {
    return (
      this.db
        .prepare(
          "SELECT data FROM funding_entities WHERE collection=? ORDER BY rowid DESC",
        )
        .all(collection) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get<K extends Collection>(collection: K, id: string): Entities[K] {
    const row = this.db
      .prepare("SELECT data FROM funding_entities WHERE collection=? AND id=?")
      .get(collection, id) as { data: string } | undefined;
    if (!row) fail(`${collection} record not found`, 404);
    return JSON.parse(row.data);
  }
  private save<K extends Collection>(
    collection: K,
    value: Entities[K],
    action: string,
  ): Entities[K] {
    const previous = this.db
      .prepare("SELECT data FROM funding_entities WHERE collection=? AND id=?")
      .get(collection, value.id) as { data: string } | undefined;
    const previousTime = previous
      ? Date.parse(JSON.parse(previous.data).updatedAt)
      : 0;
    value.updatedAt = new Date(
      Math.max(Date.now(), previousTime + 1),
    ).toISOString();
    this.db
      .prepare(
        "INSERT INTO funding_entities(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data",
      )
      .run(collection, value.id, JSON.stringify(value));
    this.db
      .prepare(
        "INSERT INTO funding_changes(entity,entity_id,action,at,data,source,before_data) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        collection,
        value.id,
        action,
        value.updatedAt,
        JSON.stringify(value),
        this.operationSource,
        previous?.data ?? null,
      );
    return value;
  }
  changes(after = 0): Change[] {
    if (!Number.isSafeInteger(after) || after < 0)
      fail("invalid changes cursor");
    return (
      this.db
        .prepare(
          "SELECT * FROM funding_changes WHERE sequence>? ORDER BY sequence LIMIT 1000",
        )
        .all(after) as {
        sequence: number;
        entity: Collection;
        entity_id: string;
        action: string;
        at: string;
        data: string;
        source: string;
        before_data: string | null;
      }[]
    ).map((r) => ({
      sequence: r.sequence,
      entity: r.entity,
      entityId: r.entity_id,
      action: r.action,
      at: r.at,
      data: JSON.parse(r.data),
      source: r.source,
      before: r.before_data ? JSON.parse(r.before_data) : null,
    }));
  }
  private base() {
    const now = new Date().toISOString();
    return { id: randomUUID(), createdAt: now, updatedAt: now };
  }
  private account(id: unknown): Account {
    const a = this.get("accounts", text(id, "accountId", true));
    if (a.archived) fail("account is archived", 409);
    return a;
  }
  private available(batch: Batch): bigint {
    if (batch.voided) return BigInt(0);
    let remaining = BigInt(batch.amount);
    for (const t of this.list("transfers"))
      if (t.status !== "void")
        for (const a of t.allocations)
          if (a.batchId === batch.id) remaining -= BigInt(a.amount);
    return remaining;
  }
  batches(): Batch[] {
    return this.list("batches").map((b) => ({
      ...b,
      availableAmount: this.available(b).toString(),
    }));
  }
  private createBatch(input: Input, action = "created"): Batch {
    const account = this.account(input.accountId);
    if (account.kind !== "bank")
      fail("funding batches must belong to bank accounts");
    const amount = money(input.amount);
    const sourceStatus = input.sourceStatus ?? "unverified";
    if (
      typeof sourceStatus !== "string" ||
      !["unverified", "partial", "verified"].includes(sourceStatus)
    )
      fail("invalid sourceStatus");
    return this.save(
      "batches",
      {
        ...this.base(),
        accountId: account.id,
        name: text(input.name, "name") || "资金批次",
        currency: currency(input.currency),
        amount,
        availableAmount: amount,
        sourceStatus: sourceStatus as Batch["sourceStatus"],
        sourceNote: text(input.sourceNote, "sourceNote"),
        note: text(input.note, "note"),
        occurredAt: date(input.occurredAt),
        voided: false,
      },
      action,
    );
  }
  private createTransfer(
    input: Input,
    correctionOf: string | null = null,
  ): Transfer {
    const kind = input.kind as Transfer["kind"];
    if (!["bank", "broker", "exchange", "withdrawal"].includes(kind))
      fail("invalid transfer kind");
    const historical = bool(input.historical);
    const from = input.fromAccountId ? this.account(input.fromAccountId) : null;
    const to = input.toAccountId ? this.account(input.toAccountId) : null;
    if (historical && kind !== "broker")
      fail("historical deposits must be broker transfers");
    if ((!historical || from) && (!from || from.kind !== "bank"))
      fail("source must be a bank account");
    if (kind === "withdrawal" ? !!to : !to) fail("invalid destination account");
    if (to && (kind === "broker" ? to.kind !== "broker" : to.kind !== "bank"))
      fail("destination account kind does not match transfer");
    if (from && to && from.id === to.id && kind !== "exchange")
      fail("source and destination must differ");
    const cur = currency(input.currency),
      amount = money(input.amount),
      feeAmount = money(input.feeAmount ?? "0", "feeAmount", true);
    const receivedCurrency = currency(input.receivedCurrency ?? cur),
      receivedAmount = money(input.receivedAmount ?? amount, "receivedAmount");
    if (kind !== "exchange" && receivedCurrency !== cur)
      fail("currency changes require exchange kind");
    if (kind === "exchange" && cur === receivedCurrency)
      fail("exchange currencies must differ");
    if (kind !== "exchange" && BigInt(receivedAmount) > BigInt(amount))
      fail("receivedAmount cannot exceed amount for same-currency transfers");
    if (historical && feeAmount !== "0")
      fail("historical transfers cannot charge source fees");
    const raw = input.allocations ?? [];
    if (!Array.isArray(raw) || raw.length > 1000)
      fail("allocations must be an array");
    const allocations: Allocation[] = [];
    const seen = new Set<string>();
    let total = BigInt(0);
    for (const a of raw) {
      if (!a || typeof a !== "object") fail("invalid allocation");
      const batchId = text(a.batchId, "batchId", true);
      if (seen.has(batchId)) fail("duplicate batch allocation");
      seen.add(batchId);
      const b = this.get("batches", batchId),
        n = money(a.amount);
      if (b.voided || b.accountId !== from?.id || b.currency !== cur)
        fail("allocation account or currency mismatch");
      if (BigInt(n) > this.available(b))
        fail("allocation exceeds available batch funds", 409);
      total += BigInt(n);
      allocations.push({ batchId, amount: n });
    }
    if (
      historical && !from
        ? allocations.length > 0
        : total !== BigInt(amount) + BigInt(feeAmount)
    )
      fail("allocations must cover amount plus feeAmount exactly");
    if (
      input.status !== undefined &&
      input.status !== "pending" &&
      input.status !== "confirmed"
    )
      fail("new transfer status must be pending or confirmed");
    const transfer = this.save(
      "transfers",
      {
        ...this.base(),
        kind,
        fromAccountId: from?.id ?? null,
        toAccountId: to?.id ?? null,
        currency: cur,
        amount,
        receivedCurrency,
        receivedAmount,
        feeAmount,
        allocations,
        status: "pending",
        historical,
        pathStatus: "unverified",
        pathNote: "",
        note: text(input.note, "note"),
        occurredAt: date(input.occurredAt),
        confirmedAt: null,
        resultBatchId: null,
        correctionOf,
      },
      "created",
    );
    return input.status === "confirmed"
      ? (this.write("POST", "transfers", transfer.id, "confirm", {
          confirmedAt: input.confirmedAt ?? input.occurredAt,
        }) as Transfer)
      : transfer;
  }
  private voidTransfer(id: string, input: Input): Transfer {
    const t = this.get("transfers", id);
    if (t.status === "void") fail("transfer already void", 409);
    if (t.resultBatchId) {
      const b = this.get("batches", t.resultBatchId);
      if (this.available(b) !== BigInt(b.amount))
        fail(
          "destination funds have been allocated; void downstream transfers first",
          409,
        );
      b.voided = true;
      b.availableAmount = "0";
      this.save("batches", b, "voided");
    }
    t.status = "void";
    if (input.note !== undefined) t.note = text(input.note, "note");
    return this.save("transfers", t, "voided");
  }
  mutate(
    method: string,
    collection: Collection,
    id: string | undefined,
    action: string | undefined,
    input: Input,
    key?: string,
    source = "api",
  ): unknown {
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail("request body must be an object");
    if (key && key.length > 200) fail("Idempotency-Key too long");
    const fingerprint = canonical({
      method,
      collection,
      id: id ?? null,
      action: action ?? null,
      input,
    });
    return this.db
      .transaction(() => {
        if (key) {
          const prior = this.db
            .prepare(
              "SELECT fingerprint,response FROM funding_idempotency WHERE key=?",
            )
            .get(key) as { fingerprint: string; response: string } | undefined;
          if (prior) {
            if (prior.fingerprint !== fingerprint)
              fail("Idempotency-Key was used for a different request", 409);
            return JSON.parse(prior.response);
          }
        }
        if (
          id &&
          input.expectedUpdatedAt !== undefined &&
          input.expectedUpdatedAt !== this.get(collection, id).updatedAt
        )
          fail("record changed; reload before updating", 409);
        this.operationSource = text(source, "operation source") || "api";
        const response = this.write(method, collection, id, action, input);
        if (key)
          this.db
            .prepare("INSERT INTO funding_idempotency VALUES(?,?,?)")
            .run(key, fingerprint, JSON.stringify(response));
        return response;
      })
      .immediate();
  }
  private write(
    method: string,
    collection: Collection,
    id: string | undefined,
    action: string | undefined,
    input: Input,
  ): unknown {
    if (method === "POST" && !id) {
      if (collection === "accounts") {
        if (input.kind !== "bank" && input.kind !== "broker")
          fail("invalid account kind");
        return this.save(
          "accounts",
          {
            ...this.base(),
            name: text(input.name, "name", true),
            kind: input.kind,
            institution: text(input.institution, "institution"),
            note: text(input.note, "note"),
            archived: false,
          },
          "created",
        );
      }
      if (collection === "batches") return this.createBatch(input);
      if (collection === "transfers") return this.createTransfer(input);
      if (collection === "goals") {
        const g: Goal = {
          ...this.base(),
          accountId: input.accountId ? this.broker(input.accountId) : null,
          currency: currency(input.currency),
          amount: money(input.amount),
          floorAmount:
            input.floorAmount == null
              ? null
              : money(input.floorAmount, "floorAmount", true),
          startDate: nullableDate(input.startDate),
          endDate: nullableDate(input.endDate),
          name: text(input.name, "name") || "入金目标",
          note: text(input.note, "note"),
        };
        goalWindow(g);
        return this.save("goals", g, "created");
      }
    }
    if (id && method === "PATCH" && !action) {
      if (collection === "accounts") {
        const a = this.get("accounts", id);
        for (const field of ["name", "institution", "note"] as const)
          if (input[field] !== undefined)
            a[field] = text(input[field], field, field === "name");
        a.archived = bool(input.archived, a.archived);
        return this.save("accounts", a, "updated");
      }
      if (collection === "goals") {
        const g = this.get("goals", id);
        if (input.accountId !== undefined)
          g.accountId =
            input.accountId === null ? null : this.broker(input.accountId);
        if (input.amount !== undefined) g.amount = money(input.amount);
        if (input.currency !== undefined) g.currency = currency(input.currency);
        for (const field of ["name", "note"] as const)
          if (input[field] !== undefined)
            g[field] = text(input[field], field, field === "name");
        if (input.floorAmount !== undefined)
          g.floorAmount =
            input.floorAmount === null
              ? null
              : money(input.floorAmount, "floorAmount", true);
        if (input.startDate !== undefined)
          g.startDate = nullableDate(input.startDate);
        if (input.endDate !== undefined)
          g.endDate = nullableDate(input.endDate);
        goalWindow(g);
        return this.save("goals", g, "updated");
      }
    }
    if (id && method === "POST") {
      if (collection === "transfers") {
        if (action === "verify") {
          const t = this.get("transfers", id);
          if (t.status === "void") fail("transfer is void", 409);
          const status = input.pathStatus ?? "verified";
          if (
            typeof status !== "string" ||
            !["unverified", "partial", "verified"].includes(status)
          )
            fail("invalid pathStatus");
          t.pathStatus = status as Transfer["pathStatus"];
          t.pathNote = text(input.pathNote ?? input.note, "pathNote");
          return this.save("transfers", t, "verified");
        }
        if (action === "allocations") {
          const t = this.get("transfers", id);
          if (!t.historical || t.status === "void" || t.allocations.length)
            fail(
              "only unsourced historical deposits can receive allocations",
              409,
            );
          const replacement = this.createTransfer({
            ...t,
            ...input,
            status: "pending",
            kind: "broker",
            historical: false,
            amount: t.amount,
            currency: t.currency,
            receivedAmount: t.receivedAmount,
            receivedCurrency: t.receivedCurrency,
            toAccountId: t.toAccountId,
            feeAmount: "0",
          });
          this.db
            .prepare(
              "DELETE FROM funding_entities WHERE collection='transfers' AND id=?",
            )
            .run(replacement.id);
          this.db
            .prepare(
              "DELETE FROM funding_changes WHERE entity='transfers' AND entity_id=?",
            )
            .run(replacement.id);
          t.fromAccountId = replacement.fromAccountId;
          t.allocations = replacement.allocations;
          t.pathStatus = "partial";
          return this.save("transfers", t, "allocated");
        }
        if (action === "void") return this.voidTransfer(id, input);
        if (action === "correct") {
          this.voidTransfer(id, {});
          return this.createTransfer(input, id);
        }
        if (action === "confirm") {
          const t = this.get("transfers", id);
          if (t.status !== "pending")
            fail("only pending transfers can be confirmed", 409);
          if (input.receivedAmount !== undefined) {
            t.receivedAmount = money(input.receivedAmount, "receivedAmount");
            if (
              t.kind !== "exchange" &&
              BigInt(t.receivedAmount) > BigInt(t.amount)
            )
              fail("receivedAmount cannot exceed amount");
          }
          t.status = "confirmed";
          t.confirmedAt = date(input.confirmedAt);
          if (input.note !== undefined) t.note = text(input.note, "note");
          if (t.toAccountId && t.kind !== "broker") {
            const b = this.createBatch(
              {
                accountId: t.toAccountId,
                name: "转账到账",
                currency: t.receivedCurrency,
                amount: t.receivedAmount,
                occurredAt: t.confirmedAt,
                note: t.note,
              },
              "received",
            );
            t.resultBatchId = b.id;
          }
          return this.save("transfers", t, "confirmed");
        }
      }
      if (collection === "batches") {
        const b = this.get("batches", id);
        if (b.voided) fail("batch is void", 409);
        if (action === "verify") {
          const status = input.sourceStatus ?? "verified";
          if (
            typeof status !== "string" ||
            !["unverified", "partial", "verified"].includes(status)
          )
            fail("invalid sourceStatus");
          b.sourceStatus = status as Batch["sourceStatus"];
          b.sourceNote = text(input.sourceNote ?? input.note, "sourceNote");
          return this.save("batches", b, "verified");
        }
        if (action === "void") {
          if (
            this.list("transfers").some(
              (t) => t.resultBatchId === id && t.status !== "void",
            )
          )
            fail("void the originating transfer instead", 409);
          if (this.available(b) !== BigInt(b.amount))
            fail("batch has allocated funds", 409);
          b.voided = true;
          b.availableAmount = "0";
          return this.save("batches", b, "voided");
        }
      }
    }
    fail("unsupported operation", 405);
  }
  private broker(id: unknown) {
    const a = this.account(id);
    if (a.kind !== "broker") fail("goal account must be a broker");
    return a.id;
  }
  summary(): Summary {
    const currencies = new Map<
      string,
      {
        bankAvailable: bigint;
        brokerConfirmed: bigint;
        inTransit: bigint;
        goalAmount: bigint;
      }
    >();
    const accountTotals = new Map<
      string,
      {
        accountId: string;
        currency: string;
        availableAmount: bigint;
        confirmedAmount: bigint;
      }
    >();
    const bucket = (c: string) => {
      if (!currencies.has(c))
        currencies.set(c, {
          bankAvailable: BigInt(0),
          brokerConfirmed: BigInt(0),
          inTransit: BigInt(0),
          goalAmount: BigInt(0),
        });
      return currencies.get(c)!;
    };
    const account = (id: string, c: string) => {
      const key = `${id}:${c}`;
      if (!accountTotals.has(key))
        accountTotals.set(key, {
          accountId: id,
          currency: c,
          availableAmount: BigInt(0),
          confirmedAmount: BigInt(0),
        });
      return accountTotals.get(key)!;
    };
    for (const b of this.batches())
      if (!b.voided) {
        bucket(b.currency).bankAvailable += BigInt(b.availableAmount);
        account(b.accountId, b.currency).availableAmount += BigInt(
          b.availableAmount,
        );
      }
    for (const t of this.list("transfers")) {
      if (t.status === "pending")
        bucket(t.receivedCurrency).inTransit += BigInt(t.receivedAmount);
      if (t.status === "confirmed" && t.kind === "broker") {
        bucket(t.receivedCurrency).brokerConfirmed += BigInt(t.receivedAmount);
        account(t.toAccountId!, t.receivedCurrency).confirmedAmount += BigInt(
          t.receivedAmount,
        );
      }
    }
    for (const g of this.list("goals"))
      bucket(g.currency).goalAmount += BigInt(g.amount);
    const goals = this.list("goals").map((g) => {
      let actual = BigInt(0);
      for (const t of this.list("transfers")) {
        const when = Date.parse(t.confirmedAt ?? t.occurredAt);
        const end =
          g.endDate && /^\d{4}-\d{2}-\d{2}$/.test(g.endDate)
            ? Date.parse(g.endDate) + 86400000 - 1
            : g.endDate
              ? Date.parse(g.endDate)
              : null;
        if (
          t.status === "confirmed" &&
          t.kind === "broker" &&
          t.receivedCurrency === g.currency &&
          (!g.accountId || t.toAccountId === g.accountId) &&
          (!g.startDate || when >= Date.parse(g.startDate)) &&
          (end === null || when <= end)
        )
          actual += BigInt(t.receivedAmount);
      }
      return {
        ...g,
        actualAmount: String(actual),
        remainingAmount: String(
          actual < BigInt(g.amount) ? BigInt(g.amount) - actual : BigInt(0),
        ),
        floorReached: g.floorAmount === null || actual >= BigInt(g.floorAmount),
        achieved: actual >= BigInt(g.amount),
      };
    });
    return {
      goals,
      currencies: [...currencies]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, b]) => ({
          currency,
          bankAvailable: String(b.bankAvailable),
          brokerConfirmed: String(b.brokerConfirmed),
          inTransit: String(b.inTransit),
          goalAmount: String(b.goalAmount),
          remainingAmount: String(
            goals
              .filter((g) => g.currency === currency)
              .reduce((sum, g) => sum + BigInt(g.remainingAmount), BigInt(0)),
          ),
        })),
      accounts: [...accountTotals.values()].map((a) => ({
        ...a,
        availableAmount: String(a.availableAmount),
        confirmedAmount: String(a.confirmedAmount),
      })),
    };
  }
}
