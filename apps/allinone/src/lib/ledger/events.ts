import { randomUUID } from "node:crypto";

import {
  dbQuery,
  type LedgerQueryFn,
  withTransaction,
} from "@/lib/ledger/db";
import type { ConfigOption } from "@/lib/ledger/config";
import { getDefaultConfigCode, listActiveConfigOptions } from "@/lib/ledger/config";
import {
  listActiveResellerPackagePriceOptions,
} from "@/lib/ledger/pricing";
import { eventTypeLabels, type EventRecord, type EventType } from "@/lib/ledger/schema";
import {
  buildShanghaiTimestampSlug,
  formatShanghaiDateTime,
  getCurrentShanghaiDateLocal,
  getCurrentShanghaiDateTimeLocal,
  toShanghaiDateEndExclusiveIso,
  toShanghaiDateStartIso,
  toShanghaiIsoString,
} from "@/lib/ledger/time";

export const eventExportLimit = 5000;
export const eventPageSizeOptions = [10, 20, 50] as const;

type EventState = {
  activated_at: string | null;
  event_type: EventType | null;
  exists_in_history: boolean;
  is_active: boolean;
};

type DashboardEventRow = {
  cdk: string | null;
  created_at: string;
  event_type: EventType;
  occurred_at: string;
  related_cdk: string | null;
};

type EventListRow = EventRecord & {
  counterparty_name: string | null;
  package_name: string | null;
  platform_name: string | null;
};

type QueryFn = LedgerQueryFn;

type BaseEventInput = {
  occurredAt: string;
  note: string;
  redeemedAt?: string;
};

type EventUpdateInput = {
  cdk: string;
  counterpartyCode: string;
  costPrice: string;
  id: string;
  note: string;
  occurredAt: string;
  packageCode: string;
  platformCode: string;
  platformFeeAmount: string;
  platformFeeFixedAmount: string;
  platformFeeRatePercent: string;
  redeemedAt: string;
  relatedCdk: string;
  salePrice: string;
  supplyPrice: string;
};

type IssueSelfInput = BaseEventInput & {
  cdk: string;
  packageCode: string;
  platformCode: string;
};

type IssueResellerInput = BaseEventInput & {
  cdk: string;
  counterpartyCode: string;
  packageCode: string;
  platformCode?: string;
};

type ReplaceInput = BaseEventInput & {
  newCdk: string;
  oldCdk: string;
  packageCode: string;
  platformCode: string;
};

type VoidInput = BaseEventInput & {
  cdk: string;
};

type PriceSnapshot = {
  cost_price: string | null;
  platform_fee_amount: string | null;
  platform_fee_fixed_amount: string | null;
  platform_fee_rate_percent: string | null;
  sale_price: string | null;
  supply_price: string | null;
};

type MutableEventRecord = {
  cdk: string | null;
  cost_price: string | null;
  counterparty_code: string | null;
  created_at: string;
  event_type: EventType;
  id: string;
  note: string | null;
  occurred_at: string;
  package_code: string | null;
  platform_code: string | null;
  platform_fee_amount: string | null;
  platform_fee_fixed_amount: string | null;
  platform_fee_rate_percent: string | null;
  redeemed_at: string | null;
  related_cdk: string | null;
  sale_price: string | null;
  supply_price: string | null;
};

type EditableEventRecord = Omit<
  MutableEventRecord,
  | "created_at"
  | "event_type"
  | "cost_price"
  | "platform_fee_amount"
  | "platform_fee_fixed_amount"
  | "platform_fee_rate_percent"
  | "sale_price"
  | "supply_price"
  | "id"
>;

export type EventFormKind = EventType;

export type EventFilters = {
  cdk: string;
  counterpartyCode: string;
  dateFrom: string;
  dateTo: string;
  note: string;
  eventType: "" | EventType;
  packageCode: string;
  platformCode: string;
};

export type EventListItem = EventRecord & {
  counterparty_name: string | null;
  package_name: string | null;
  platform_name: string | null;
};

export type DashboardStats = {
  activeTotal: number;
  issueResellerActive: number;
  issueSelfActive: number;
  voidCount: number;
};

export type EventDetailView = EventListItem;

export type EventListPage = {
  items: EventListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type EventProfitSummary = {
  gross_profit: string;
  issue_count: number;
  refund_count: number;
  void_count: number;
  missing_price_count: number;
  platform_fee: string;
  priced_count: number;
  product_cost: string;
  revenue: string;
  total_cost: string;
};

type EventStatus = {
  active: boolean;
  category: "issue_self" | "issue_reseller" | null;
};

type SearchParamSource =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function normalizeCode(input: string) {
  return input.trim().toLowerCase();
}

function normalizeCdk(input: string) {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeNote(input: string) {
  return input.trim();
}

function getQueryValue(source: SearchParamSource, key: string) {
  if (source instanceof URLSearchParams) {
    return source.get(key) ?? "";
  }

  const value = source[key];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function normalizeDateInput(input: string) {
  const value = input.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function normalizePage(input: string) {
  const value = Number.parseInt(input.trim(), 10);

  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }

  return value;
}

function normalizePageSize(input: string) {
  const value = Number.parseInt(input.trim(), 10);

  if (
    Number.isFinite(value) &&
    eventPageSizeOptions.includes(
      value as (typeof eventPageSizeOptions)[number],
    )
  ) {
    return value;
  }

  return eventPageSizeOptions[0];
}

function assertCode(input: string, label: string) {
  const value = normalizeCode(input);

  if (!value) {
    throw new Error(`${label}不能为空。`);
  }

  return value;
}

function assertCdk(input: string, label: string) {
  const value = normalizeCdk(input);

  if (!value) {
    throw new Error(`${label}不能为空。`);
  }

  return value;
}

function toEventPayload(input: BaseEventInput) {
  const redeemedAt = input.redeemedAt ? toShanghaiIsoString(input.redeemedAt) : null;

  return {
    occurredAt: toShanghaiIsoString(input.occurredAt),
    redeemedAt,
    note: normalizeNote(input.note) || null,
  };
}

function mapEventWriteError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "events_type_occurred_cdk_unique_idx"
  ) {
    return new Error("相同事件类型、相同时间、相同 CDK 的记录已存在，不能重复添加。");
  }

  return error;
}

async function assertActiveOption(
  kind: "package" | "platform" | "reseller",
  code: string,
  label: string,
) {
  const result = await dbQuery<{ code: string }>(
    `
      select code
      from ${kind === "package"
        ? "packages"
        : kind === "platform"
          ? "sales_platforms"
          : "resellers"}
      where code = $1
        and is_active = true
    `,
    [code],
  );

  if (result.rowCount === 0) {
    throw new Error(`${label}不存在或已停用。`);
  }
}

function parseDecimalUnits(value: string, scale: number, label: string) {
  const normalized = value.trim();
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`);

  if (!pattern.test(normalized)) {
    throw new Error(`${label}配置无效。`);
  }

  const [whole, fraction = ""] = normalized.split(".");
  const unit = 10 ** scale;
  return Number(whole) * unit + Number(fraction.padEnd(scale, "0") || "0");
}

function formatMoneyCents(cents: number) {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}

function formatDecimalUnits(units: number, scale: number) {
  return (units / 10 ** scale).toFixed(scale).replace(/\.?0+$/, "") || "0";
}

function getMoneyCents(value: string, label: string) {
  return parseDecimalUnits(value, 2, label);
}

function normalizeSnapshotMoney(value: string | null, label: string) {
  return value === null ? null : formatMoneyCents(getMoneyCents(value, label));
}

function normalizeSnapshotRate(value: string | null) {
  return value === null
    ? null
    : formatDecimalUnits(parseDecimalUnits(value, 4, "手续费比例"), 4);
}

function normalizePriceSnapshot(snapshot: PriceSnapshot): PriceSnapshot {
  return {
    cost_price: normalizeSnapshotMoney(snapshot.cost_price, "成本价"),
    platform_fee_amount: normalizeSnapshotMoney(snapshot.platform_fee_amount, "平台手续费"),
    platform_fee_fixed_amount: normalizeSnapshotMoney(
      snapshot.platform_fee_fixed_amount,
      "固定手续费",
    ),
    platform_fee_rate_percent: normalizeSnapshotRate(snapshot.platform_fee_rate_percent),
    sale_price: normalizeSnapshotMoney(snapshot.sale_price, "售卖价"),
    supply_price: normalizeSnapshotMoney(snapshot.supply_price, "供货价"),
  };
}

function buildUpdatedPriceSnapshot(
  eventType: EventType,
  input: EventUpdateInput,
): PriceSnapshot {
  if (eventType !== "issue_self" && eventType !== "issue_reseller") {
    return {
      cost_price: null,
      platform_fee_amount: null,
      platform_fee_fixed_amount: null,
      platform_fee_rate_percent: null,
      sale_price: null,
      supply_price: null,
    };
  }

  const costPrice = input.costPrice.trim()
    ? formatMoneyCents(getMoneyCents(input.costPrice, "成本价"))
    : null;
  const salePrice = input.salePrice.trim()
    ? formatMoneyCents(getMoneyCents(input.salePrice, "售卖价"))
    : null;
  const supplyPrice = input.supplyPrice.trim()
    ? formatMoneyCents(getMoneyCents(input.supplyPrice, "供货价"))
    : null;
  const platformFeeRatePercent = input.platformFeeRatePercent.trim()
    ? formatDecimalUnits(
        parseDecimalUnits(input.platformFeeRatePercent, 4, "手续费比例"),
        4,
      )
    : null;
  const platformFeeFixedAmount = input.platformFeeFixedAmount.trim()
    ? formatMoneyCents(getMoneyCents(input.platformFeeFixedAmount, "固定手续费"))
    : null;
  const platformFeeAmount = input.platformFeeAmount.trim()
    ? formatMoneyCents(getMoneyCents(input.platformFeeAmount, "平台手续费"))
    : null;

  if (eventType === "issue_self") {
    const values = [
      costPrice,
      salePrice,
      platformFeeRatePercent,
      platformFeeFixedAmount,
      platformFeeAmount,
    ];
    const hasAnyValue = values.some((value) => value !== null);

    if (hasAnyValue && values.some((value) => value === null)) {
      throw new Error("自营事件的价格快照需完整填写，或全部留空。");
    }

    return {
      cost_price: costPrice,
      platform_fee_amount: platformFeeAmount,
      platform_fee_fixed_amount: platformFeeFixedAmount,
      platform_fee_rate_percent: platformFeeRatePercent,
      sale_price: salePrice,
      supply_price: null,
    };
  }

  const hasBasePrice = costPrice !== null || supplyPrice !== null;
  const hasAnyFee =
    platformFeeRatePercent !== null
    || platformFeeFixedAmount !== null
    || platformFeeAmount !== null;
  const hasCompleteBasePrice = costPrice !== null && supplyPrice !== null;
  const hasCompleteFee =
    platformFeeRatePercent !== null
    && platformFeeFixedAmount !== null
    && platformFeeAmount !== null;

  if (hasBasePrice && !hasCompleteBasePrice) {
    throw new Error("下游事件的成本价和供货价需同时填写，或同时留空。");
  }

  if (hasAnyFee && (!hasCompleteFee || !hasCompleteBasePrice)) {
    throw new Error("下游事件的手续费字段需完整填写，且必须先填写成本价和供货价。");
  }

  return {
    cost_price: costPrice,
    platform_fee_amount: platformFeeAmount,
    platform_fee_fixed_amount: platformFeeFixedAmount,
    platform_fee_rate_percent: platformFeeRatePercent,
    sale_price: null,
    supply_price: supplyPrice,
  };
}

function calculatePlatformFee(
  baseAmount: string,
  feeRatePercent: string,
  feeFixedAmount: string,
) {
  const baseCents = getMoneyCents(baseAmount, "计费金额");
  const rateUnits = parseDecimalUnits(feeRatePercent, 4, "手续费比例");
  const fixedCents = getMoneyCents(feeFixedAmount, "固定手续费");
  const feeCents = Math.round(baseCents * rateUnits / 1000000) + fixedCents;

  return formatMoneyCents(feeCents);
}

async function getPriceSnapshot(
  query: QueryFn,
  input: {
    counterpartyCode?: string | null;
    eventType: "issue_self" | "issue_reseller";
    packageCode: string;
    platformCode?: string | null;
  },
): Promise<PriceSnapshot> {
  const packageResult = await query<{
    cost_price: string | null;
    sale_price: string | null;
  }>(
    `
      select cost_price, sale_price
      from packages
      where code = $1
        and is_active = true
      limit 1
    `,
    [input.packageCode],
  );
  const packagePricing = packageResult.rows[0];

  if (!packagePricing || packagePricing.cost_price === null || packagePricing.sale_price === null) {
    throw new Error("该套餐尚未完整配置成本价和售卖价。");
  }

  if (input.eventType === "issue_self") {
    const platformResult = await query<{
      fee_fixed_amount: string;
      fee_rate_percent: string;
    }>(
      `
        select fee_rate_percent, fee_fixed_amount
        from sales_platforms
        where code = $1
          and is_active = true
        limit 1
      `,
      [input.platformCode],
    );
    const platformPricing = platformResult.rows[0];

    if (!platformPricing) {
      throw new Error("售卖平台不存在或已停用。");
    }

    return {
      cost_price: formatMoneyCents(getMoneyCents(packagePricing.cost_price, "成本价")),
      platform_fee_amount: calculatePlatformFee(
        packagePricing.sale_price,
        platformPricing.fee_rate_percent,
        platformPricing.fee_fixed_amount,
      ),
      platform_fee_fixed_amount: formatMoneyCents(
        getMoneyCents(platformPricing.fee_fixed_amount, "固定手续费"),
      ),
      platform_fee_rate_percent: platformPricing.fee_rate_percent,
      sale_price: formatMoneyCents(getMoneyCents(packagePricing.sale_price, "售卖价")),
      supply_price: null,
    };
  }

  const supplyResult = await query<{ supply_price: string }>(
    `
      select supply_price
      from reseller_package_prices
      where reseller_code = $1
        and package_code = $2
      limit 1
    `,
    [input.counterpartyCode, input.packageCode],
  );
  const supplyPrice = supplyResult.rows[0]?.supply_price;

  if (!supplyPrice) {
    throw new Error("该下游尚未配置此套餐的供货价。");
  }

  let platformFee: Pick<
    PriceSnapshot,
    "platform_fee_amount" | "platform_fee_fixed_amount" | "platform_fee_rate_percent"
  > = {
    platform_fee_amount: null,
    platform_fee_fixed_amount: null,
    platform_fee_rate_percent: null,
  };

  if (input.platformCode) {
    const platformResult = await query<{
      fee_fixed_amount: string;
      fee_rate_percent: string;
    }>(
      `
        select fee_rate_percent, fee_fixed_amount
        from sales_platforms
        where code = $1
          and is_active = true
        limit 1
      `,
      [input.platformCode],
    );
    const platformPricing = platformResult.rows[0];

    if (!platformPricing) {
      throw new Error("售卖平台不存在或已停用。");
    }

    platformFee = {
      platform_fee_amount: calculatePlatformFee(
        supplyPrice,
        platformPricing.fee_rate_percent,
        platformPricing.fee_fixed_amount,
      ),
      platform_fee_fixed_amount: formatMoneyCents(
        getMoneyCents(platformPricing.fee_fixed_amount, "固定手续费"),
      ),
      platform_fee_rate_percent: platformPricing.fee_rate_percent,
    };
  }

  return {
    cost_price: formatMoneyCents(getMoneyCents(packagePricing.cost_price, "成本价")),
    sale_price: null,
    supply_price: formatMoneyCents(getMoneyCents(supplyPrice, "供货价")),
    ...platformFee,
  };
}

async function getEventState(
  cdk: string,
  query: QueryFn = dbQuery,
  excludeId?: string,
) {
  const values = excludeId ? [cdk, excludeId] : [cdk];
  const excludeClause = excludeId ? "and id <> $2" : "";
  const result = await query<EventState>(
    `
      with activations as (
        select
          occurred_at,
          created_at,
          event_type,
          cdk as code
        from events
        where event_type in ('issue_self', 'issue_reseller')
          and cdk = $1
          ${excludeClause}

        union all

        select
          occurred_at,
          created_at,
          'replace' as event_type,
          related_cdk as code
        from events
        where event_type = 'replace'
          and related_cdk = $1
          ${excludeClause}
      ),
      deactivations as (
        select
          occurred_at,
          created_at,
          cdk as code
        from events
        where event_type in ('void', 'replace')
          and cdk = $1
          ${excludeClause}
      ),
      latest_activation as (
        select occurred_at, created_at, event_type
        from activations
        order by occurred_at desc, created_at desc
        limit 1
      ),
      latest_deactivation as (
        select occurred_at, created_at
        from deactivations
        order by occurred_at desc, created_at desc
        limit 1
      )
      select
        latest_activation.occurred_at as activated_at,
        latest_activation.event_type,
        exists(
          select 1
          from events
          where cdk = $1 or related_cdk = $1
            ${excludeClause}
        ) as exists_in_history,
        case
          when latest_activation.occurred_at is null then 0
          when latest_deactivation.occurred_at is null then 1
          when (
            latest_activation.occurred_at,
            latest_activation.created_at
          ) > (
            latest_deactivation.occurred_at,
            latest_deactivation.created_at
          ) then 1
          else 0
        end as is_active
      from (select 1) as base
      left join latest_activation on true
      left join latest_deactivation on true
    `,
    values,
  );

  const row = result.rows[0];

  return {
    activated_at: row?.activated_at ?? null,
    event_type: row?.event_type ?? null,
    exists_in_history: Boolean(row?.exists_in_history),
    is_active: Boolean(row?.is_active),
  };
}

function normalizeOptionalCode(input: string) {
  const value = normalizeCode(input);
  return value || null;
}

async function getMutableEvent(id: string, query: QueryFn = dbQuery) {
  const result = await query<MutableEventRecord>(
    `
      select
        id,
        event_type,
        occurred_at,
        redeemed_at,
        package_code,
        platform_code,
        cdk,
        cost_price,
        related_cdk,
        counterparty_code,
        platform_fee_amount,
        platform_fee_fixed_amount,
        platform_fee_rate_percent,
        sale_price,
        supply_price,
        note,
        created_at
      from events
      where id = $1
      limit 1
    `,
    [id],
  );

  return result.rows[0] ?? null;
}

function hasHighRiskChange(
  current: MutableEventRecord,
  next: EditableEventRecord,
) {
  return (
    current.occurred_at !== next.occurred_at ||
    (current.cdk ?? "") !== (next.cdk ?? "") ||
    (current.related_cdk ?? "") !== (next.related_cdk ?? "")
  );
}

async function assertNoLaterRelatedEvents(
  current: MutableEventRecord,
  next: EditableEventRecord,
  query: QueryFn,
) {
  const codes = [...new Set([
    current.cdk,
    current.related_cdk,
    next.cdk,
    next.related_cdk,
  ].filter((value): value is string => Boolean(value)))];

  if (codes.length === 0) {
    return;
  }

  const result = await query<{ id: string }>(
    `
      select id
      from events
      where id <> $1
        and (cdk in (select json_each.value from json_each($2))
          or related_cdk in (select json_each.value from json_each($2)))
        and (
          occurred_at > $3
          or (occurred_at = $3 and created_at > $4)
          or (occurred_at = $3 and created_at = $4 and id > $1)
        )
      limit 1
    `,
    [current.id, JSON.stringify(codes), current.occurred_at, current.created_at],
  );

  if (result.rows.length > 0) {
    throw new Error("当前记录已存在后续关联事件，不能修改日期时间或 CDK 字段。");
  }
}

async function assertChangedActiveOption(
  currentValue: string | null,
  nextValue: string | null,
  kind: "package" | "platform" | "reseller",
  label: string,
) {
  if (!nextValue || currentValue === nextValue) {
    return;
  }

  await assertActiveOption(kind, nextValue, label);
}

function buildUpdatedEvent(
  current: MutableEventRecord,
  input: EventUpdateInput,
): EditableEventRecord {
  const occurredAt = toShanghaiIsoString(input.occurredAt);
  const redeemedAt = input.redeemedAt ? toShanghaiIsoString(input.redeemedAt) : null;
  const note = normalizeNote(input.note) || null;

  if (current.event_type === "issue_self") {
    return {
      occurred_at: occurredAt,
      redeemed_at: redeemedAt ?? occurredAt,
      package_code: assertCode(input.packageCode, "套餐类型"),
      platform_code: assertCode(input.platformCode, "售卖平台"),
      cdk: assertCdk(input.cdk, "CDK"),
      related_cdk: null,
      counterparty_code: null,
      note,
    };
  }

  if (current.event_type === "issue_reseller") {
    return {
      occurred_at: occurredAt,
      redeemed_at: redeemedAt ?? occurredAt,
      package_code: assertCode(input.packageCode, "套餐类型"),
      platform_code: normalizeOptionalCode(input.platformCode),
      cdk: assertCdk(input.cdk, "CDK"),
      related_cdk: null,
      counterparty_code: assertCode(input.counterpartyCode, "下游对象"),
      note,
    };
  }

  if (current.event_type === "void") {
    return {
      occurred_at: occurredAt,
      redeemed_at: null,
      package_code: null,
      platform_code: null,
      cdk: assertCdk(input.cdk, "CDK"),
      related_cdk: null,
      counterparty_code: null,
      note,
    };
  }

  const cdk = assertCdk(input.cdk, "旧 CDK");
  const relatedCdk = assertCdk(input.relatedCdk, "新 CDK");

  if (cdk === relatedCdk) {
    throw new Error("旧 CDK 和新 CDK 不能相同。");
  }

  return {
    occurred_at: occurredAt,
    redeemed_at: null,
    package_code: assertCode(input.packageCode, "套餐类型"),
    platform_code: assertCode(input.platformCode, "售卖平台"),
    cdk,
    related_cdk: relatedCdk,
    counterparty_code: null,
    note,
  };
}

function hasEventChanged(
  current: MutableEventRecord,
  next: EditableEventRecord,
  nextPriceSnapshot: PriceSnapshot | null,
) {
  const currentPriceSnapshot = nextPriceSnapshot
    ? normalizePriceSnapshot({
        cost_price: current.cost_price,
        platform_fee_amount: current.platform_fee_amount,
        platform_fee_fixed_amount: current.platform_fee_fixed_amount,
        platform_fee_rate_percent: current.platform_fee_rate_percent,
        sale_price: current.sale_price,
        supply_price: current.supply_price,
      })
    : null;

  return (
    current.occurred_at !== next.occurred_at ||
    (current.redeemed_at ?? "") !== (next.redeemed_at ?? "") ||
    (current.package_code ?? "") !== (next.package_code ?? "") ||
    (current.platform_code ?? "") !== (next.platform_code ?? "") ||
    (current.cdk ?? "") !== (next.cdk ?? "") ||
    (current.related_cdk ?? "") !== (next.related_cdk ?? "") ||
    (current.counterparty_code ?? "") !== (next.counterparty_code ?? "") ||
    (current.note ?? "") !== (next.note ?? "") ||
    (currentPriceSnapshot !== null &&
      (currentPriceSnapshot.cost_price !== nextPriceSnapshot?.cost_price ||
        currentPriceSnapshot.platform_fee_amount !== nextPriceSnapshot?.platform_fee_amount ||
        currentPriceSnapshot.platform_fee_fixed_amount !== nextPriceSnapshot?.platform_fee_fixed_amount ||
        currentPriceSnapshot.platform_fee_rate_percent !== nextPriceSnapshot?.platform_fee_rate_percent ||
        currentPriceSnapshot.sale_price !== nextPriceSnapshot?.sale_price ||
        currentPriceSnapshot.supply_price !== nextPriceSnapshot?.supply_price))
  );
}

async function assertEventUpdateState(
  current: MutableEventRecord,
  next: EditableEventRecord,
  query: QueryFn,
) {
  if (current.event_type === "issue_self" || current.event_type === "issue_reseller") {
    const state = await getEventState(next.cdk ?? "", query, current.id);

    if (state.is_active) {
      throw new Error("该 CDK 已存在有效成功记录，不能保存为当前事件。");
    }

    return;
  }

  if (current.event_type === "void") {
    const state = await getEventState(next.cdk ?? "", query, current.id);

    if (!state.exists_in_history) {
      throw new Error("该 CDK 不存在历史记录，不能保存作废事件。");
    }

    return;
  }

  const [oldState, newState] = await Promise.all([
    getEventState(next.cdk ?? "", query, current.id),
    getEventState(next.related_cdk ?? "", query, current.id),
  ]);

  if (!oldState.exists_in_history) {
    throw new Error("旧 CDK 不存在历史记录，不能保存换新事件。");
  }

  if (!oldState.is_active) {
    throw new Error("旧 CDK 当前不是有效成功记录，不能保存换新事件。");
  }

  if (newState.is_active) {
    throw new Error("新 CDK 已存在有效成功记录，不能作为换新结果。");
  }
}

export async function listEventFormOptions() {
  const [
    packages,
    resellers,
    platforms,
    defaultPackageCode,
    defaultResellerCode,
    defaultPlatformCode,
    resellerPackagePrices,
  ] = await Promise.all([
    listActiveConfigOptions("package"),
    listActiveConfigOptions("reseller"),
    listActiveConfigOptions("platform"),
    getDefaultConfigCode("package"),
    getDefaultConfigCode("reseller"),
    getDefaultConfigCode("platform"),
    listActiveResellerPackagePriceOptions(),
  ]);

  return {
    packages,
    resellers,
    platforms,
    resellerPackagePrices,
    defaults: {
      packageCode: defaultPackageCode,
      counterpartyCode: defaultResellerCode,
      platformCode: defaultPlatformCode,
    },
  };
}

export function parseEventFilters(source: SearchParamSource): EventFilters {
  const defaults = getDefaultEventFilters();
  const eventType = getQueryValue(source, "eventType");

  return {
    dateFrom: normalizeDateInput(getQueryValue(source, "dateFrom")) || defaults.dateFrom,
    dateTo: normalizeDateInput(getQueryValue(source, "dateTo")) || defaults.dateTo,
    eventType: isEventKind(eventType) ? eventType : "",
    cdk: normalizeCdk(getQueryValue(source, "cdk")),
    note: normalizeNote(getQueryValue(source, "note")),
    packageCode: normalizeCode(getQueryValue(source, "packageCode")),
    platformCode: normalizeCode(getQueryValue(source, "platformCode")),
    counterpartyCode: normalizeCode(getQueryValue(source, "counterpartyCode")),
  };
}

export function parseEventPage(source: SearchParamSource) {
  return normalizePage(getQueryValue(source, "page"));
}

export function parseEventPageSize(source: SearchParamSource) {
  return normalizePageSize(getQueryValue(source, "pageSize"));
}

export function shouldCalculateEventProfit(source: SearchParamSource) {
  return getQueryValue(source, "calculate") === "1";
}

function buildEventFilterWhere(filters: EventFilters) {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.dateFrom) {
    values.push(toShanghaiDateStartIso(filters.dateFrom));
    conditions.push(`e.occurred_at >= $${values.length}`);
  }

  if (filters.dateTo) {
    values.push(toShanghaiDateEndExclusiveIso(filters.dateTo));
    conditions.push(`e.occurred_at < $${values.length}`);
  }

  if (filters.eventType) {
    values.push(filters.eventType);
    conditions.push(`e.event_type = $${values.length}`);
  }

  if (filters.cdk) {
    values.push(filters.cdk);
    conditions.push(`(e.cdk = $${values.length} or e.related_cdk = $${values.length})`);
  }

  if (filters.note) {
    values.push(`%${filters.note}%`);
    conditions.push(`coalesce(e.note, '') like $${values.length}`);
  }

  if (filters.packageCode) {
    values.push(filters.packageCode);
    conditions.push(`e.package_code = $${values.length}`);
  }

  if (filters.platformCode) {
    values.push(filters.platformCode);
    conditions.push(`e.platform_code = $${values.length}`);
  }

  if (filters.counterpartyCode) {
    values.push(filters.counterpartyCode);
    conditions.push(`e.counterparty_code = $${values.length}`);
  }

  return {
    values,
    whereClause: conditions.length > 0 ? `where ${conditions.join(" and ")}` : "",
  };
}

export function getEventKindOptions() {
  return (Object.keys(eventTypeLabels) as EventType[]).map((value) => ({
    value,
    label: eventTypeLabels[value],
  }));
}

export async function createIssueSelf(input: IssueSelfInput) {
  const payload = toEventPayload(input);
  const cdk = assertCdk(input.cdk, "CDK");
  const packageCode = assertCode(input.packageCode, "套餐类型");
  const platformCode = assertCode(input.platformCode, "售卖平台");

  await Promise.all([
    assertActiveOption("package", packageCode, "套餐类型"),
    assertActiveOption("platform", platformCode, "售卖平台"),
  ]);

  try {
    await withTransaction(async (query) => {
      const state = await getEventState(cdk, query);

      if (state.is_active) {
        throw new Error("该 CDK 已存在有效成功记录，不能重复登记。");
      }

      const priceSnapshot = await getPriceSnapshot(query, {
        eventType: "issue_self",
        packageCode,
        platformCode,
      });

      await query(
        `
          insert into events (
            id,
            event_type,
            occurred_at,
            redeemed_at,
            package_code,
            platform_code,
            cdk,
            cost_price,
            sale_price,
            platform_fee_rate_percent,
            platform_fee_fixed_amount,
            platform_fee_amount,
            note
          )
          values (?, 'issue_self', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          payload.occurredAt,
          payload.redeemedAt ?? payload.occurredAt,
          packageCode,
          platformCode,
          cdk,
          priceSnapshot.cost_price,
          priceSnapshot.sale_price,
          priceSnapshot.platform_fee_rate_percent,
          priceSnapshot.platform_fee_fixed_amount,
          priceSnapshot.platform_fee_amount,
          payload.note,
        ],
      );
    });
  } catch (error) {
    throw mapEventWriteError(error);
  }
}

export async function createIssueReseller(input: IssueResellerInput) {
  const payload = toEventPayload(input);
  const cdk = assertCdk(input.cdk, "CDK");
  const packageCode = assertCode(input.packageCode, "套餐类型");
  const platformCode = normalizeCode(input.platformCode ?? "") || null;
  const counterpartyCode = assertCode(input.counterpartyCode, "下游对象");

  await Promise.all(
    [
      assertActiveOption("package", packageCode, "套餐类型"),
      assertActiveOption("reseller", counterpartyCode, "下游对象"),
      platformCode
        ? assertActiveOption("platform", platformCode, "售卖平台")
        : Promise.resolve(),
    ],
  );

  try {
    await withTransaction(async (query) => {
      const state = await getEventState(cdk, query);

      if (state.is_active) {
        throw new Error("该 CDK 已存在有效成功记录，不能重复登记。");
      }

      const priceSnapshot = await getPriceSnapshot(query, {
        counterpartyCode,
        eventType: "issue_reseller",
        packageCode,
        platformCode,
      });

      await query(
        `
          insert into events (
            id,
            event_type,
            occurred_at,
            redeemed_at,
            package_code,
            platform_code,
            cdk,
            counterparty_code,
            cost_price,
            supply_price,
            platform_fee_rate_percent,
            platform_fee_fixed_amount,
            platform_fee_amount,
            note
          )
          values (?, 'issue_reseller', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          payload.occurredAt,
          payload.redeemedAt ?? payload.occurredAt,
          packageCode,
          platformCode,
          cdk,
          counterpartyCode,
          priceSnapshot.cost_price,
          priceSnapshot.supply_price,
          priceSnapshot.platform_fee_rate_percent,
          priceSnapshot.platform_fee_fixed_amount,
          priceSnapshot.platform_fee_amount,
          payload.note,
        ],
      );
    });
  } catch (error) {
    throw mapEventWriteError(error);
  }
}

export async function createVoid(input: VoidInput) {
  const payload = toEventPayload(input);
  const cdk = assertCdk(input.cdk, "CDK");

  try {
    await withTransaction(async (query) => {
      const state = await getEventState(cdk, query);

      if (!state.exists_in_history) {
        throw new Error("该 CDK 不存在历史记录，不能作废。");
      }

      await query(
        `
          insert into events (
            id,
            event_type,
            occurred_at,
            cdk,
            note
          )
          values (?, 'void', ?, ?, ?)
        `,
        [randomUUID(), payload.occurredAt, cdk, payload.note],
      );
    });
  } catch (error) {
    throw mapEventWriteError(error);
  }
}

export async function createReplace(input: ReplaceInput) {
  const payload = toEventPayload(input);
  const oldCdk = assertCdk(input.oldCdk, "旧 CDK");
  const newCdk = assertCdk(input.newCdk, "新 CDK");
  const packageCode = assertCode(input.packageCode, "套餐类型");
  const platformCode = assertCode(input.platformCode, "售卖平台");

  if (oldCdk === newCdk) {
    throw new Error("旧 CDK 和新 CDK 不能相同。");
  }

  await Promise.all([
    assertActiveOption("package", packageCode, "套餐类型"),
    assertActiveOption("platform", platformCode, "售卖平台"),
  ]);

  try {
    await withTransaction(async (query) => {
      const [oldState, newState] = await Promise.all([
        getEventState(oldCdk, query),
        getEventState(newCdk, query),
      ]);

      if (!oldState.exists_in_history) {
        throw new Error("旧 CDK 不存在历史记录，不能换新。");
      }

      if (!oldState.is_active) {
        throw new Error("旧 CDK 当前不是有效成功记录，不能换新。");
      }

      if (newState.is_active) {
        throw new Error("新 CDK 已存在有效成功记录，不能作为换新结果。");
      }

      await query(
        `
          insert into events (
            id,
            event_type,
            occurred_at,
            package_code,
            platform_code,
            cdk,
            related_cdk,
            note
          )
          values (?, 'replace', ?, ?, ?, ?, ?, ?)
        `,
        [randomUUID(), payload.occurredAt, packageCode, platformCode, oldCdk, newCdk, payload.note],
      );
    });
  } catch (error) {
    throw mapEventWriteError(error);
  }
}

export async function listRecentEvents(
  limit = 10,
  order: "occurred" | "created" = "occurred",
) {
  const orderBy =
    order === "created"
      ? "e.created_at desc, e.id desc"
      : "e.occurred_at desc, e.created_at desc";

  const result = await dbQuery<EventListRow>(
    `
      select
        e.source_event_id,
        e.refund_amount,
        e.cost_returned,
        e.fee_returned,
        e.id,
        e.event_type,
        e.occurred_at,
        e.redeemed_at,
        e.package_code,
        p.name as package_name,
        e.platform_code,
        sp.name as platform_name,
        e.cdk,
        e.cost_price,
        e.related_cdk,
        e.counterparty_code,
        e.platform_fee_amount,
        e.platform_fee_fixed_amount,
        e.platform_fee_rate_percent,
        e.sale_price,
        e.supply_price,
        r.name as counterparty_name,
        e.note,
        e.created_at,
        e.updated_at
      from events e
      left join packages p on p.code = e.package_code
      left join sales_platforms sp on sp.code = e.platform_code
      left join resellers r on r.code = e.counterparty_code
      order by ${orderBy}
      limit $1
    `,
    [limit],
  );

  return result.rows;
}

export async function listEventDetails(filters: EventFilters) {
  const { whereClause, values } = buildEventFilterWhere(filters);
  const result = await dbQuery<EventListRow>(
    `
      select
        e.source_event_id,
        e.refund_amount,
        e.cost_returned,
        e.fee_returned,
        e.id,
        e.event_type,
        e.occurred_at,
        e.redeemed_at,
        e.package_code,
        p.name as package_name,
        e.platform_code,
        sp.name as platform_name,
        e.cdk,
        e.cost_price,
        e.related_cdk,
        e.counterparty_code,
        e.platform_fee_amount,
        e.platform_fee_fixed_amount,
        e.platform_fee_rate_percent,
        e.sale_price,
        e.supply_price,
        r.name as counterparty_name,
        e.note,
        e.created_at,
        e.updated_at
      from events e
      left join packages p on p.code = e.package_code
      left join sales_platforms sp on sp.code = e.platform_code
      left join resellers r on r.code = e.counterparty_code
      ${whereClause}
      order by e.occurred_at desc, e.created_at desc
    `,
    values,
  );

  return result.rows;
}

export async function listEventDetailsPage(
  filters: EventFilters,
  page: number,
  pageSize: number,
): Promise<EventListPage> {
  const { whereClause, values } = buildEventFilterWhere(filters);
  const countResult = await dbQuery<{ total: number | string }>(
    `
      select count(*) as total
      from events e
      ${whereClause}
    `,
    values,
  );

  const total = Number(countResult.rows[0]?.total ?? 0);
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const offset = (safePage - 1) * pageSize;

  const result = await dbQuery<EventListRow>(
    `
      select
        e.source_event_id,
        e.refund_amount,
        e.cost_returned,
        e.fee_returned,
        e.id,
        e.event_type,
        e.occurred_at,
        e.redeemed_at,
        e.package_code,
        p.name as package_name,
        e.platform_code,
        sp.name as platform_name,
        e.cdk,
        e.cost_price,
        e.related_cdk,
        e.counterparty_code,
        e.platform_fee_amount,
        e.platform_fee_fixed_amount,
        e.platform_fee_rate_percent,
        e.sale_price,
        e.supply_price,
        r.name as counterparty_name,
        e.note,
        e.created_at,
        e.updated_at
      from events e
      left join packages p on p.code = e.package_code
      left join sales_platforms sp on sp.code = e.platform_code
      left join resellers r on r.code = e.counterparty_code
      ${whereClause}
      order by e.occurred_at desc, e.created_at desc
      limit $${values.length + 1}
      offset $${values.length + 2}
    `,
    [...values, pageSize, offset],
  );

  return {
    items: result.rows,
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

export async function getEventProfitSummary(filters: EventFilters) {
  const { whereClause, values } = buildEventFilterWhere(filters);
  const profitWhereClause = whereClause
    ? `${whereClause} and e.event_type in ('issue_self', 'issue_reseller', 'refund', 'void')`
    : "where e.event_type in ('issue_self', 'issue_reseller', 'refund', 'void')";
  const result = await dbQuery<Omit<EventProfitSummary, "issue_count" | "refund_count" | "void_count" | "missing_price_count" | "priced_count"> & {
    issue_count: number | string;
    refund_count: number | string;
    void_count: number | string;
    missing_price_count: number | string;
    priced_count: number | string;
  }>(
    `
      with filtered_events as (
        select
          e.event_type,
          case when e.event_type = 'refund' then decimal_neg(e.cost_returned) else e.cost_price end as cost_price,
          case when e.event_type = 'refund' then decimal_neg(e.fee_returned)
            else coalesce(e.platform_fee_amount, 0) end as platform_fee_amount,
          case
            when e.event_type = 'refund' then decimal_neg(e.refund_amount)
            when e.event_type = 'issue_self' then e.sale_price
            else e.supply_price
          end as revenue
        from events e
        ${profitWhereClause}
      ),
      priced_events as (
        select *
        from filtered_events
        where cost_price is not null
          and revenue is not null
      )
      select
        (select count(*) from filtered_events where event_type in ('issue_self', 'issue_reseller')) as issue_count,
        (select count(*) from filtered_events where event_type = 'refund') as refund_count,
        (select count(*) from filtered_events where event_type = 'void') as void_count,
        (select count(*) from priced_events) as priced_count,
        (
          (select count(*) from filtered_events where event_type <> 'void')
          - (select count(*) from priced_events)
        ) as missing_price_count,
        coalesce(decimal_sum(revenue), 0) as revenue,
        coalesce(decimal_sum(cost_price), 0) as product_cost,
        coalesce(decimal_sum(platform_fee_amount), 0) as platform_fee,
        decimal_add(coalesce(decimal_sum(cost_price), '0'), coalesce(decimal_sum(platform_fee_amount), '0')) as total_cost,
        decimal_sub(decimal_sub(coalesce(decimal_sum(revenue), '0'), coalesce(decimal_sum(cost_price), '0')), coalesce(decimal_sum(platform_fee_amount), '0')) as gross_profit
      from priced_events
    `,
    values,
  );

  const row = result.rows[0];

  if (!row) {
    return {
      gross_profit: "0",
      issue_count: 0,
      refund_count: 0,
      void_count: 0,
      missing_price_count: 0,
      platform_fee: "0",
      priced_count: 0,
      product_cost: "0",
      revenue: "0",
      total_cost: "0",
    };
  }

  // Decimal SQL functions return exact decimal strings, matching PG numeric aggregation.
  return {
    gross_profit: String(row.gross_profit ?? "0"),
    issue_count: Number(row.issue_count ?? 0),
    refund_count: Number(row.refund_count ?? 0),
    void_count: Number(row.void_count ?? 0),
    missing_price_count: Number(row.missing_price_count ?? 0),
    platform_fee: String(row.platform_fee ?? "0"),
    priced_count: Number(row.priced_count ?? 0),
    product_cost: String(row.product_cost ?? "0"),
    revenue: String(row.revenue ?? "0"),
    total_cost: String(row.total_cost ?? "0"),
  };
}

export async function getEventDetail(id: string) {
  const result = await dbQuery<EventListRow>(
    `
      select
        e.source_event_id,
        e.refund_amount,
        e.cost_returned,
        e.fee_returned,
        e.id,
        e.event_type,
        e.occurred_at,
        e.redeemed_at,
        e.package_code,
        p.name as package_name,
        e.platform_code,
        sp.name as platform_name,
        e.cdk,
        e.cost_price,
        e.related_cdk,
        e.counterparty_code,
        e.platform_fee_amount,
        e.platform_fee_fixed_amount,
        e.platform_fee_rate_percent,
        e.sale_price,
        e.supply_price,
        r.name as counterparty_name,
        e.note,
        e.created_at,
        e.updated_at
      from events e
      left join packages p on p.code = e.package_code
      left join sales_platforms sp on sp.code = e.platform_code
      left join resellers r on r.code = e.counterparty_code
      where e.id = $1
      limit 1
    `,
    [id],
  );

  return result.rows[0] ?? null;
}

export async function updateEvent(input: EventUpdateInput) {
  const id = input.id.trim();

  if (!id) {
    throw new Error("事件不存在。");
  }

  try {
    return await withTransaction(async (query) => {
      await query("select id from events where id = $1", [id]);
      const current = await getMutableEvent(id, query);

      if (!current) {
        throw new Error("事件不存在。");
      }

      if (current.event_type === "refund") {
        throw new Error("请使用退款金额表单修改退款记录。");
      }
      const refunds = await query("select id from events where source_event_id = $1 limit 1", [id]);
      if (refunds.rows.length > 0) {
        throw new Error("该发货记录已关联退款，为保持账目一致，不能修改原单。请先核对退款记录。");
      }
      const next = buildUpdatedEvent(current, input);
      const priceSnapshot =
        current.event_type === "issue_self" || current.event_type === "issue_reseller"
          ? buildUpdatedPriceSnapshot(current.event_type, input)
          : null;

      if (!hasEventChanged(current, next, priceSnapshot)) {
        return false;
      }

      await Promise.all([
        assertChangedActiveOption(
          current.package_code,
          next.package_code,
          "package",
          "套餐类型",
        ),
        assertChangedActiveOption(
          current.platform_code,
          next.platform_code,
          "platform",
          "售卖平台",
        ),
        assertChangedActiveOption(
          current.counterparty_code,
          next.counterparty_code,
          "reseller",
          "下游对象",
        ),
      ]);

      if (hasHighRiskChange(current, next)) {
        await assertNoLaterRelatedEvents(current, next, query);
        await assertEventUpdateState(current, next, query);
      }

      const priceAssignments = priceSnapshot
        ? `,
            cost_price = $10,
            sale_price = $11,
            supply_price = $12,
            platform_fee_rate_percent = $13,
            platform_fee_fixed_amount = $14,
            platform_fee_amount = $15`
        : "";
      const priceValues = priceSnapshot
        ? [
            priceSnapshot.cost_price,
            priceSnapshot.sale_price,
            priceSnapshot.supply_price,
            priceSnapshot.platform_fee_rate_percent,
            priceSnapshot.platform_fee_fixed_amount,
            priceSnapshot.platform_fee_amount,
          ]
        : [];

      const result = await query(
        `
          update events
          set
            occurred_at = $2,
            redeemed_at = $3,
            package_code = $4,
            platform_code = $5,
            cdk = $6,
            related_cdk = $7,
            counterparty_code = $8,
            note = $9${priceAssignments}
          where id = $1
        `,
        [
          current.id,
          next.occurred_at,
          next.redeemed_at,
          next.package_code,
          next.platform_code,
          next.cdk,
          next.related_cdk,
          next.counterparty_code,
          next.note,
          ...priceValues,
        ],
      );

      if (result.rowCount === 0) {
        throw new Error("事件不存在。");
      }

      return true;
    });
  } catch (error) {
    throw mapEventWriteError(error);
  }
}

export async function getDashboardStats() {
  const result = await dbQuery<DashboardEventRow>(
    `
      select
        event_type,
        occurred_at,
        created_at,
        cdk,
        related_cdk
      from events
      order by occurred_at asc, created_at asc
    `,
  );

  const states = new Map<string, EventStatus>();
  let voidCount = 0;

  for (const row of result.rows) {
    if (row.event_type === "issue_self" && row.cdk) {
      states.set(row.cdk, {
        active: true,
        category: "issue_self",
      });
      continue;
    }

    if (row.event_type === "issue_reseller" && row.cdk) {
      states.set(row.cdk, {
        active: true,
        category: "issue_reseller",
      });
      continue;
    }

    if (row.event_type === "void" && row.cdk) {
      voidCount += 1;
      const previous = states.get(row.cdk);
      states.set(row.cdk, {
        active: false,
        category: previous?.category ?? null,
      });
      continue;
    }

    if (row.event_type === "replace" && row.cdk && row.related_cdk) {
      const previous = states.get(row.cdk);
      states.set(row.cdk, {
        active: false,
        category: previous?.category ?? null,
      });
      states.set(row.related_cdk, {
        active: true,
        category: previous?.category ?? null,
      });
    }
  }

  let activeTotal = 0;
  let issueSelfActive = 0;
  let issueResellerActive = 0;

  for (const state of states.values()) {
    if (!state.active) {
      continue;
    }

    activeTotal += 1;

    if (state.category === "issue_self") {
      issueSelfActive += 1;
    }

    if (state.category === "issue_reseller") {
      issueResellerActive += 1;
    }
  }

  return {
    activeTotal,
    issueSelfActive,
    issueResellerActive,
    voidCount,
  };
}

export function toEventSuccessMessage(kind: EventType) {
  return kind === "void"
    ? "作废已记录。作废不会自动退款，请打开该记录详情核实退款与成本退回。"
    : `${eventTypeLabels[kind]}已记录。`;
}

export function buildEventHistoryEntry(
  kind: EventType,
  input: {
    cdk?: string;
    counterpartyCode?: string;
    occurredAt?: string;
    redeemedAt?: string;
    oldCdk?: string;
    packageCode?: string;
    platformCode?: string;
    newCdk?: string;
  },
) {
  const parts = [eventTypeLabels[kind]];

  if (input.occurredAt) {
    parts.push(input.occurredAt.trim());
  }

  if (input.redeemedAt) {
    parts.push(`兑 ${input.redeemedAt.trim()}`);
  }

  if (input.packageCode) {
    parts.push(`套餐 ${input.packageCode.trim().toLowerCase()}`);
  }

  if (input.platformCode) {
    parts.push(`平台 ${input.platformCode.trim().toLowerCase()}`);
  }

  if (input.counterpartyCode) {
    parts.push(`下游 ${input.counterpartyCode.trim().toLowerCase()}`);
  }

  if (kind === "replace") {
    if (input.oldCdk) {
      parts.push(`旧 ${normalizeCdk(input.oldCdk)}`);
    }

    if (input.newCdk) {
      parts.push(`新 ${normalizeCdk(input.newCdk)}`);
    }
  } else if (input.cdk) {
    parts.push(`CDK ${normalizeCdk(input.cdk)}`);
  }

  return parts.join(" · ");
}

export function isEventKind(value: string): value is EventType {
  return value in eventTypeLabels;
}

export function getEventFormDefaults(
  kind: EventType,
  defaults?: {
    counterpartyCode?: string;
    packageCode?: string;
    platformCode?: string;
  },
  values?: Record<string, string>,
) {
  return {
    kind,
    occurredAt: values?.occurredAt ?? "",
    redeemedAt:
      kind === "issue_self" || kind === "issue_reseller"
        ? values?.redeemedAt ?? values?.occurredAt ?? ""
        : "",
    packageCode: values?.packageCode ?? defaults?.packageCode ?? "",
    platformCode:
      kind === "issue_reseller"
        ? values?.platformCode ?? ""
        : values?.platformCode ?? defaults?.platformCode ?? "",
    counterpartyCode: values?.counterpartyCode ?? defaults?.counterpartyCode ?? "",
    cdk: values?.cdk ?? "",
    oldCdk: values?.oldCdk ?? "",
    newCdk: values?.newCdk ?? "",
    note: values?.note ?? "",
  };
}

export function toOptionMap(items: ConfigOption[]) {
  return new Map(items.map((item) => [item.code, item.name]));
}

export function getDefaultEventFilters(useToday = false) {
  const today = useToday ? getCurrentShanghaiDateLocal() : "";

  return {
    dateFrom: today,
    dateTo: today,
    eventType: "",
    cdk: "",
    note: "",
    packageCode: "",
    platformCode: "",
    counterpartyCode: "",
  } satisfies EventFilters;
}

export function getEventListTitle(filters: EventFilters) {
  const parts: string[] = [];

  if (filters.eventType) {
    parts.push(eventTypeLabels[filters.eventType]);
  }

  if (filters.dateFrom || filters.dateTo) {
    parts.push("按日期筛选");
  }

  if (filters.cdk) {
    parts.push(`CDK: ${filters.cdk}`);
  }

  if (filters.note) {
    parts.push(`备注: ${filters.note}`);
  }

  if (filters.platformCode) {
    parts.push(`平台: ${filters.platformCode}`);
  }

  return parts.length > 0 ? parts.join(" / ") : "全部事件";
}

export function buildEventExportFileName(now = getCurrentShanghaiDateTimeLocal()) {
  const slug = buildShanghaiTimestampSlug(now);
  return `events-${slug.slice(0, 8)}-${slug.slice(8)}00.csv`;
}

export function getEventGrossProfit(event: Pick<
  EventRecord,
  "event_type" | "cost_price" | "platform_fee_amount" | "sale_price" | "supply_price"
  | "refund_amount" | "cost_returned" | "fee_returned"
>) {
  if (event.event_type === "refund") {
    return formatMoneyCents(
      -getMoneyCents(event.refund_amount ?? "0", "退款金额")
      + getMoneyCents(event.cost_returned ?? "0", "成本退回")
      + getMoneyCents(event.fee_returned ?? "0", "手续费退回"),
    );
  }
  const basePrice = event.sale_price ?? event.supply_price;

  if (!basePrice || event.cost_price === null) {
    return null;
  }

  const profitCents =
    getMoneyCents(basePrice, "计费金额")
    - getMoneyCents(event.cost_price, "成本价")
    - (event.platform_fee_amount
      ? getMoneyCents(event.platform_fee_amount, "平台手续费")
      : 0);

  return formatMoneyCents(profitCents);
}

function escapeCsvValue(value: string) {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

export function toEventCsv(rows: EventListItem[]) {
  const header = [
    "事件时间",
    "事件类型",
    "兑换时间",
    "套餐类型",
    "售卖平台",
    "CDK",
    "关联 CDK",
    "下游对象",
    "成本价",
    "售卖价",
    "供货价",
    "平台费率",
    "固定手续费",
    "平台手续费",
    "毛利影响",
    "原发货记录 ID",
    "退款金额",
    "成本退回",
    "手续费退回",
    "备注",
    "创建时间",
    "更新时间",
  ];

  const body = rows.map((row) =>
    [
      formatShanghaiDateTime(row.occurred_at),
      eventTypeLabels[row.event_type],
      row.redeemed_at ? formatShanghaiDateTime(row.redeemed_at) : "",
      row.package_name ?? row.package_code ?? "",
      row.platform_name ?? row.platform_code ?? "",
      row.cdk ?? "",
      row.related_cdk ?? "",
      row.counterparty_name ?? row.counterparty_code ?? "",
      row.cost_price ?? "",
      row.sale_price ?? "",
      row.supply_price ?? "",
      row.platform_fee_rate_percent ?? "",
      row.platform_fee_fixed_amount ?? "",
      row.platform_fee_amount ?? "",
      getEventGrossProfit(row) ?? "",
      row.source_event_id ?? "",
      row.refund_amount ?? "",
      row.cost_returned ?? "",
      row.fee_returned ?? "",
      row.note ?? "",
      formatShanghaiDateTime(row.created_at),
      row.updated_at ? formatShanghaiDateTime(row.updated_at) : "",
    ]
      .map((value) => escapeCsvValue(String(value)))
      .join(","),
  );

  return `\uFEFF${[header.join(","), ...body].join("\n")}`;
}
