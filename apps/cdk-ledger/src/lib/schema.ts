export const eventTypes = [
  "issue_self",
  "issue_reseller",
  "void",
  "replace",
  "refund",
] as const;

export type EventType = (typeof eventTypes)[number];

export const eventTypeLabels: Record<EventType, string> = {
  issue_self: "自营发货",
  issue_reseller: "下游代发",
  void: "作废",
  replace: "换新",
  refund: "退款/退回",
};

export type PackageRecord = {
  code: string;
  cost_price: string | null;
  name: string;
  is_active: boolean;
  is_default: boolean;
  sale_price: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string | null;
};

export type ResellerRecord = {
  code: string;
  name: string;
  is_active: boolean;
  is_default: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string | null;
};

export type SalesPlatformRecord = {
  code: string;
  fee_fixed_amount: string;
  fee_rate_percent: string;
  name: string;
  is_active: boolean;
  is_default: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string | null;
};

export type EventRecord = {
  source_event_id: string | null;
  refund_amount: string | null;
  cost_returned: string | null;
  fee_returned: string | null;
  cost_price: string | null;
  id: string;
  event_type: EventType;
  occurred_at: string;
  redeemed_at: string | null;
  package_code: string | null;
  platform_code: string | null;
  cdk: string | null;
  related_cdk: string | null;
  counterparty_code: string | null;
  note: string | null;
  platform_fee_amount: string | null;
  platform_fee_fixed_amount: string | null;
  platform_fee_rate_percent: string | null;
  sale_price: string | null;
  supply_price: string | null;
  created_at: string;
  updated_at: string | null;
};
