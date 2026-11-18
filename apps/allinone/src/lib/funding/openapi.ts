const string = { type: "string" };
const nullable = { type: ["string", "null"] };
const money = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,29})$",
  description:
    "Integer minor units (cents): HKD 20,000.00 = '2000000'. Positive except fee/floor.",
};
const verification = {
  type: "string",
  enum: ["unverified", "partial", "verified"],
};
const date = {
  type: "string",
  description: "Valid YYYY-MM-DD or ISO timestamp with timezone.",
};
const allocation = {
  type: "object",
  required: ["batchId", "amount"],
  properties: { batchId: string, amount: money },
};
const allocations = { type: "array", items: allocation };
const expected = {
  type: "string",
  description:
    "For updates: supply the last-read updatedAt; stale records return 409. Idempotent retries still replay successfully.",
};
const base = {
  id: { ...string, readOnly: true },
  createdAt: { ...string, readOnly: true },
  updatedAt: { ...string, readOnly: true },
  expectedUpdatedAt: expected,
};
const account = {
  name: string,
  kind: { enum: ["bank", "broker"] },
  institution: string,
  note: string,
  archived: { type: "boolean" },
};
const batch = {
  accountId: string,
  name: string,
  currency: string,
  amount: money,
  sourceStatus: verification,
  sourceNote: string,
  note: string,
  occurredAt: date,
};
const transfer = {
  kind: { enum: ["bank", "broker", "exchange", "withdrawal"] },
  fromAccountId: nullable,
  toAccountId: nullable,
  currency: string,
  amount: money,
  receivedCurrency: string,
  receivedAmount: money,
  feeAmount: money,
  allocations,
  status: { enum: ["pending", "confirmed"] },
  historical: { type: "boolean" },
  note: string,
  occurredAt: date,
  confirmedAt: date,
};
const goal = {
  name: string,
  accountId: nullable,
  currency: string,
  amount: money,
  floorAmount: { ...money, type: ["string", "null"] },
  startDate: nullable,
  endDate: nullable,
  note: string,
};
const schemas = {
  Account: { type: "object", properties: { ...base, ...account } },
  Batch: {
    type: "object",
    properties: {
      ...base,
      ...batch,
      availableAmount: { ...money, readOnly: true },
      voided: { type: "boolean", readOnly: true },
    },
  },
  Transfer: {
    type: "object",
    properties: {
      ...base,
      ...transfer,
      status: { enum: ["pending", "confirmed", "void"] },
      pathStatus: verification,
      pathNote: string,
      resultBatchId: nullable,
      correctionOf: nullable,
    },
  },
  Goal: { type: "object", properties: { ...base, ...goal } },
  Error: { type: "object", required: ["error"], properties: { error: string } },
};
const errors = Object.fromEntries(
  [400, 403, 404, 405, 409, 413, 415, 500].map((code) => [
    code,
    {
      description:
        code === 409
          ? "Conflict: stale record, insufficient funds, duplicate confirmation or idempotency mismatch"
          : "Request error",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/Error" } },
      },
    },
  ]),
);
const response = (schema: unknown) => ({
  "200": {
    description: "Success",
    content: { "application/json": { schema } },
  },
  ...errors,
});
const write = (description: string, schema: unknown) => ({
  description,
  parameters: [
    {
      name: "Idempotency-Key",
      in: "header",
      required: false,
      schema: string,
      description:
        "Reuse only when retrying the exact same operation. Replays return the original result.",
    },
    {
      name: "X-Funding-Source",
      in: "header",
      required: false,
      schema: string,
      description:
        "Audit label, e.g. assistant or web. This is not authentication.",
    },
  ],
  requestBody: { required: true, content: { "application/json": { schema } } },
  responses: response({ type: "object" }),
});
const paths: Record<string, unknown> = {};
const collections = [
  {
    name: "accounts",
    entity: "Account",
    properties: account,
    required: ["name", "kind"],
  },
  {
    name: "batches",
    entity: "Batch",
    properties: batch,
    required: ["accountId", "currency", "amount"],
  },
  {
    name: "transfers",
    entity: "Transfer",
    properties: transfer,
    required: ["kind", "currency", "amount"],
  },
  {
    name: "goals",
    entity: "Goal",
    properties: goal,
    required: ["currency", "amount"],
  },
];
for (const c of collections) {
  const schema = { $ref: `#/components/schemas/${c.entity}` };
  paths[`/${c.name}`] = {
    get: {
      parameters: [
        "currency",
        "status",
        "kind",
        "sourceStatus",
        "pathStatus",
        "accountId",
        "fromAccountId",
        "toAccountId",
        "startDate",
        "endDate",
      ].map((name) => ({
        name,
        in: "query",
        schema: string,
        description:
          "Optional filter on applicable collection fields. Dates filter arrival date, otherwise initiation date.",
      })),
      responses: response({ type: "array", items: schema }),
    },
    post: write(
      "Create. Transfer status defaults to pending; confirmed records count immediately. Allocations must cover amount + additional feeAmount exactly. Same-currency receivedAmount may be lower than amount. Historical broker deposits may omit source and allocations. Exchange uses different currencies and creates a bank batch; withdrawals leave this ledger. Accounts cannot change kind after creation.",
      { type: "object", required: c.required, properties: c.properties },
    ),
  };
  paths[`/${c.name}/{id}`] = {
    parameters: [{ name: "id", in: "path", required: true, schema: string }],
    get: { responses: response(schema) },
    ...(["accounts", "goals"].includes(c.name)
      ? {
          patch: write(
            "Update editable fields; supply expectedUpdatedAt for conflict detection.",
            {
              type: "object",
              properties: { ...c.properties, expectedUpdatedAt: expected },
            },
          ),
        }
      : {}),
  };
}
for (const [collection, actions] of [
  ["transfers", ["confirm", "void", "correct", "verify", "allocations"]],
  ["batches", ["verify", "void"]],
] as const) {
  for (const action of actions) {
    let properties: Record<string, unknown> = {
      note: string,
      expectedUpdatedAt: expected,
    };
    let description =
      "Void and release allocations. Downstream allocations must be voided first. Originating transfers must be voided instead of their resulting bank batches.";
    if (action === "correct") {
      properties = { ...transfer, expectedUpdatedAt: expected };
      description =
        "Atomically void old transfer and create replacement; supply complete transfer fields. Blocked if downstream funds are used.";
    }
    if (action === "allocations") {
      properties = {
        fromAccountId: string,
        allocations,
        expectedUpdatedAt: expected,
      };
      description =
        "Attach source once to an unsourced historical deposit, without counting the deposit again.";
    }
    if (action === "verify") {
      properties = {
        ...(collection === "batches"
          ? { sourceStatus: verification, sourceNote: string }
          : { pathStatus: verification, pathNote: string }),
        expectedUpdatedAt: expected,
      };
      description =
        "Update verification separately from arrival status. Omitted status defaults to verified.";
    }
    if (action === "confirm") {
      properties = { ...properties, confirmedAt: date, receivedAmount: money };
      description =
        "Confirm once, optionally adjusting actual receivedAmount. Bank arrivals create a spendable batch. Only confirmed broker transfers count toward goals.";
    }
    paths[`/${collection}/{id}/${action}`] = {
      parameters: [{ name: "id", in: "path", required: true, schema: string }],
      post: write(description, { type: "object", properties }),
    };
  }
}
paths["/summary"] = {
  get: {
    description:
      "Separate currencies, accounts and per-goal progress. Goal windows use confirmedAt; endDate is inclusive. Currency goalAmount/remainingAmount sum individual goals, which may overlap; they are not a deduplicated funding requirement.",
    responses: response({ type: "object" }),
  },
};
paths["/changes"] = {
  get: {
    description:
      "Ascending audit records with source, before and data (after). Maximum 1000; continue with after=last sequence.",
    parameters: [
      { name: "after", in: "query", schema: { type: "integer", minimum: 0 } },
    ],
    responses: response({ type: "array", items: { type: "object" } }),
  },
};
paths["/openapi.json"] = { get: { responses: response({ type: "object" }) } };
export const fundingOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "Funding API",
    version: "1.0.0",
    description:
      "Unauthenticated LAN API. Writes require application/json; cross-origin browser writes are rejected. All monetary values are integer minor-unit strings. Mutations and idempotency records commit in one SQLite transaction. Withdrawals remove bank funds from this ledger; broker withdrawals and investment gains are not modeled.",
  },
  servers: [{ url: "/api/funding/v1" }],
  paths,
  components: { schemas },
};
