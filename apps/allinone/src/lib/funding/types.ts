export type Currency = string;
export type Account = {
  id: string;
  name: string;
  kind: "bank" | "broker";
  institution: string;
  note: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
export type Batch = {
  id: string;
  accountId: string;
  name: string;
  currency: Currency;
  amount: string;
  availableAmount: string;
  sourceStatus: "unverified" | "partial" | "verified";
  sourceNote: string;
  note: string;
  occurredAt: string;
  voided: boolean;
  createdAt: string;
  updatedAt: string;
};
export type Allocation = { batchId: string; amount: string };
export type Transfer = {
  id: string;
  kind: "bank" | "broker" | "exchange" | "withdrawal";
  crossBorder?: boolean;
  number?: number;
  fromAccountId: string | null;
  toAccountId: string | null;
  currency: Currency;
  amount: string;
  receivedCurrency: Currency;
  receivedAmount: string;
  feeAmount: string;
  allocations: Allocation[];
  status: "pending" | "confirmed" | "void";
  historical: boolean;
  pathStatus: "unverified" | "partial" | "verified";
  pathNote: string;
  note: string;
  occurredAt: string;
  confirmedAt: string | null;
  resultBatchId: string | null;
  correctionOf: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Goal = {
  id: string;
  accountId: string | null;
  currency: Currency;
  amount: string;
  floorAmount: string | null;
  startDate: string | null;
  endDate: string | null;
  name: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};
export type CurrencySummary = {
  currency: Currency;
  bankAvailable: string;
  brokerConfirmed: string;
  inTransit: string;
  goalAmount: string;
  remainingAmount: string;
};
export type GoalProgress = Goal & {
  actualAmount: string;
  remainingAmount: string;
  floorReached: boolean;
  achieved: boolean;
};
export type Summary = {
  goals: GoalProgress[];
  currencies: CurrencySummary[];
  accounts: {
    accountId: string;
    currency: Currency;
    availableAmount: string;
    confirmedAmount: string;
  }[];
};
export type Change = {
  source: string;
  before: Account | Batch | Transfer | Goal | null;
  sequence: number;
  entity: "accounts" | "batches" | "transfers" | "goals";
  entityId: string;
  action: string;
  at: string;
  data: Account | Batch | Transfer | Goal;
};
// GET collections return direct arrays; GET /summary returns Summary; GET /changes?after=0 returns Change[].
// POST collections accept entity fields excluding generated fields; POST transfer /confirm, /void and batch /verify, /void accept {note?: string}.
// POST /transfers/:id/correct accepts a replacement transfer input; atomically voids old transfer.
// PATCH /accounts/:id and /goals/:id update editable fields. All writes accept optional Idempotency-Key header.
// Amounts are canonical nonnegative integer strings in minor units. Errors: {error:string}.
