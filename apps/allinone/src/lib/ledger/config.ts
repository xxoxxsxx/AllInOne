import { dbQuery, withTransaction } from "@/lib/ledger/db";
import type {
  PackageRecord,
  ResellerRecord,
  SalesPlatformRecord,
} from "@/lib/ledger/schema";

export const configKinds = ["package", "reseller", "platform"] as const;

export type ConfigKind = (typeof configKinds)[number];

export type ConfigListItem = {
  code: string;
  cost_price?: string | null;
  fee_fixed_amount?: string | null;
  fee_rate_percent?: string | null;
  name: string;
  is_active: boolean;
  is_default: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string | null;
  reference_count: number;
  sale_price?: string | null;
};

export type ConfigOption = {
  code: string;
  cost_price?: string | null;
  fee_fixed_amount?: string | null;
  fee_rate_percent?: string | null;
  is_default?: boolean;
  name: string;
  sale_price?: string | null;
};

const configTargets = {
  package: {
    label: "套餐类型",
    table: "packages",
    referenceColumn: "package_code",
  },
  reseller: {
    label: "下游对象",
    table: "resellers",
    referenceColumn: "counterparty_code",
  },
  platform: {
    label: "售卖平台",
    table: "sales_platforms",
    referenceColumn: "platform_code",
  },
} as const;

type ConfigTarget = (typeof configTargets)[ConfigKind];

function getTarget(kind: ConfigKind): ConfigTarget {
  return configTargets[kind];
}

function normalizeCode(input: string) {
  return input.trim().toLowerCase().replace(/\s+/g, "-");
}

function normalizeName(input: string) {
  return input.trim();
}

function assertValidKind(input: string): ConfigKind {
  if (configKinds.includes(input as ConfigKind)) {
    return input as ConfigKind;
  }

  throw new Error("不支持的配置类型。");
}

function assertValidCode(input: string) {
  const code = normalizeCode(input);

  if (!code) {
    throw new Error("编码不能为空。");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(code)) {
    throw new Error("编码只能包含小写字母、数字、短横线或下划线。");
  }

  return code;
}

function assertValidName(input: string) {
  const name = normalizeName(input);

  if (!name) {
    throw new Error("名称不能为空。");
  }

  return name;
}

function normalizeDecimal(input: string, label: string, decimals: number) {
  const value = input.trim();

  if (!value) {
    throw new Error(`${label}不能为空。`);
  }

  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);

  if (!pattern.test(value)) {
    throw new Error(`${label}必须是非负数字，最多保留 ${decimals} 位小数。`);
  }

  return Number(value).toFixed(decimals);
}

function normalizeOptionalMoney(input: string, label: string) {
  const value = input.trim();
  return value ? normalizeDecimal(value, label, 2) : null;
}

function getPricingColumns(kind: ConfigKind) {
  if (kind === "package") {
    return {
      select: "config.cost_price, config.sale_price, null as fee_rate_percent, null as fee_fixed_amount,",
      group: "config.cost_price, config.sale_price,",
    };
  }

  if (kind === "platform") {
    return {
      select: "null as cost_price, null as sale_price, config.fee_rate_percent, config.fee_fixed_amount,",
      group: "config.fee_rate_percent, config.fee_fixed_amount,",
    };
  }

  return {
    select: "null as cost_price, null as sale_price, null as fee_rate_percent, null as fee_fixed_amount,",
    group: "",
  };
}

function mapConfigRow<
  T extends
    | (PackageRecord & { reference_count: number | string })
    | (ResellerRecord & { reference_count: number | string })
    | (SalesPlatformRecord & { reference_count: number | string }),
>(row: T): ConfigListItem {
  return {
    ...row,
    reference_count: Number(row.reference_count),
  };
}

function mapPgError(error: unknown, target: ConfigTarget) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  ) {
    return new Error(`${target.label}编码已存在。`);
  }

  return error;
}

export function parseConfigKind(input: string) {
  return assertValidKind(input);
}

export async function listConfigItems(kind: ConfigKind) {
  const target = getTarget(kind);
  const pricingColumns = getPricingColumns(kind);
  const { rows } = await dbQuery<
    (PackageRecord | ResellerRecord | SalesPlatformRecord) & {
      reference_count: number | string;
    }
  >(
    `
      select
        config.code,
        ${pricingColumns.select}
        config.name,
        config.is_active,
        config.is_default,
        config.sort_order,
        config.created_at,
        config.updated_at,
        count(events.id) as reference_count
      from ${target.table} as config
      left join events
        on events.${target.referenceColumn} = config.code
      group by
        config.code,
        ${pricingColumns.group}
        config.name,
        config.is_active,
        config.is_default,
        config.sort_order,
        config.created_at,
        config.updated_at
      order by
        config.is_active desc,
        config.sort_order asc,
        config.created_at asc,
        config.code asc
    `,
  );

  return rows.map(mapConfigRow);
}

export async function listActiveConfigOptions(kind: ConfigKind) {
  const target = getTarget(kind);
  const pricingColumns = getPricingColumns(kind);
  const { rows } = await dbQuery<ConfigOption>(
    `
      select
        code,
        ${pricingColumns.select.replaceAll("config.", "").replaceAll("null as ", "null as ")}
        name,
        is_default
      from ${target.table}
      where is_active = true
      order by is_default desc, sort_order asc, created_at asc, code asc
    `,
  );

  return rows;
}

export async function getDefaultConfigCode(kind: ConfigKind) {
  const target = getTarget(kind);
  const result = await dbQuery<{ code: string }>(
    `
      select code
      from ${target.table}
      where is_active = true
        and is_default = true
      limit 1
    `,
  );

  return result.rows[0]?.code ?? "";
}

export async function createConfigItem(kind: ConfigKind, input: {
  code: string;
  costPrice?: string;
  feeFixedAmount?: string;
  feeRatePercent?: string;
  name: string;
  salePrice?: string;
}) {
  const target = getTarget(kind);
  const code = assertValidCode(input.code);
  const name = assertValidName(input.name);
  const costPrice = kind === "package"
    ? normalizeOptionalMoney(input.costPrice ?? "", "成本价")
    : null;
  const salePrice = kind === "package"
    ? normalizeOptionalMoney(input.salePrice ?? "", "售卖价")
    : null;
  const feeRatePercent = kind === "platform"
    ? normalizeDecimal(input.feeRatePercent ?? "0", "手续费比例", 4)
    : null;
  const feeFixedAmount = kind === "platform"
    ? normalizeDecimal(input.feeFixedAmount ?? "0", "固定手续费", 2)
    : null;
  const pricingColumns = kind === "package"
    ? ", cost_price, sale_price"
    : kind === "platform"
      ? ", fee_rate_percent, fee_fixed_amount"
      : "";
  const pricingValues = kind === "package"
    ? ", $3, $4"
    : kind === "platform"
      ? ", $3, $4"
      : "";
  const values = kind === "package"
    ? [code, name, costPrice, salePrice]
    : kind === "platform"
      ? [code, name, feeRatePercent, feeFixedAmount]
    : [code, name];

  try {
    await dbQuery(
      `
        insert into ${target.table} (code, name, sort_order${pricingColumns})
        values (
          $1,
          $2,
          coalesce((select max(sort_order) + 10 from ${target.table}), 10)${pricingValues}
        )
      `,
      values,
    );
  } catch (error) {
    throw mapPgError(error, target);
  }
}

export async function updateConfigPricing(kind: ConfigKind, input: {
  code: string;
  costPrice?: string;
  feeFixedAmount?: string;
  feeRatePercent?: string;
  salePrice?: string;
}) {
  const code = assertValidCode(input.code);

  if (kind === "package") {
    const costPrice = normalizeOptionalMoney(input.costPrice ?? "", "成本价");
    const salePrice = normalizeOptionalMoney(input.salePrice ?? "", "售卖价");
    const result = await dbQuery(
      `
        update packages
        set cost_price = $2, sale_price = $3
        where code = $1
        returning code
      `,
      [code, costPrice, salePrice],
    );

    if (result.rowCount === 0) {
      throw new Error("套餐类型不存在。");
    }

    return;
  }

  if (kind === "platform") {
    const feeRatePercent = normalizeDecimal(
      input.feeRatePercent ?? "0",
      "手续费比例",
      4,
    );
    const feeFixedAmount = normalizeDecimal(
      input.feeFixedAmount ?? "0",
      "固定手续费",
      2,
    );
    const result = await dbQuery(
      `
        update sales_platforms
        set fee_rate_percent = $2, fee_fixed_amount = $3
        where code = $1
        returning code
      `,
      [code, feeRatePercent, feeFixedAmount],
    );

    if (result.rowCount === 0) {
      throw new Error("售卖平台不存在。");
    }

    return;
  }

  throw new Error("该配置类型不支持价格设置。");
}

export async function setConfigItemDefault(kind: ConfigKind, input: {
  code: string;
}) {
  const target = getTarget(kind);
  const code = assertValidCode(input.code);

  await withTransaction(async (query) => {
    const result = await query<{ code: string }>(
      `
        select code
        from ${target.table}
        where code = $1
        limit 1
      `,
      [code],
    );

    if (result.rowCount === 0) {
      throw new Error(`${target.label}不存在。`);
    }

    await query(
      `
        update ${target.table}
        set is_default = false
        where is_default = true
          and code <> $1
      `,
      [code],
    );

    await query(
      `
        update ${target.table}
        set is_default = true, is_active = true
        where code = $1
      `,
      [code],
    );
  });
}

export async function setConfigItemActive(
  kind: ConfigKind,
  input: {
    code: string;
    isActive: boolean;
  },
) {
  const target = getTarget(kind);
  const code = assertValidCode(input.code);

  const result = await dbQuery(
    `
      update ${target.table}
      set
        is_active = $2,
        is_default = case when $2 = false then false else is_default end
      where code = $1
      returning code
    `,
    [code, input.isActive],
  );

  if (result.rowCount === 0) {
    throw new Error(`${target.label}不存在。`);
  }
}

export async function deleteConfigItem(kind: ConfigKind, input: {
  code: string;
}) {
  const target = getTarget(kind);
  const code = assertValidCode(input.code);

  const referenceCheck = await dbQuery<{ count: string }>(
    `
      select cast(count(*) as text) as count
      from events
      where ${target.referenceColumn} = $1
    `,
    [code],
  );

  if (Number(referenceCheck.rows[0]?.count ?? 0) > 0) {
    throw new Error(`${target.label}已被历史事件引用，不能删除。`);
  }

  if (kind === "package" || kind === "reseller") {
    const priceColumn = kind === "package" ? "package_code" : "reseller_code";
    const priceReference = await dbQuery<{ count: string }>(
      `
        select cast(count(*) as text) as count
        from reseller_package_prices
        where ${priceColumn} = $1
      `,
      [code],
    );

    if (Number(priceReference.rows[0]?.count ?? 0) > 0) {
      const priceLabel = kind === "package" ? "下游套餐供货价" : "套餐供货价";
      throw new Error(`${target.label}已配置${priceLabel}，不能删除。`);
    }
  }

  const result = await dbQuery(
    `
      delete from ${target.table}
      where code = $1
      returning code
    `,
    [code],
  );

  if (result.rowCount === 0) {
    throw new Error(`${target.label}不存在。`);
  }
}
