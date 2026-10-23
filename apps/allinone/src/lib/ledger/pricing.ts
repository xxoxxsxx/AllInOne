import { dbQuery } from "@/lib/ledger/db";

export type ResellerPackagePrice = {
  package_code: string;
  package_name: string;
  reseller_code: string;
  reseller_name: string;
  supply_price: string;
  created_at: string;
  updated_at: string | null;
};

export type ResellerPackagePriceOption = {
  package_code: string;
  reseller_code: string;
  supply_price: string;
};

function normalizeCode(input: string, label: string) {
  const value = input.trim().toLowerCase();

  if (!value) {
    throw new Error(`${label}不能为空。`);
  }

  return value;
}

function normalizeMoney(input: string) {
  const value = input.trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("供货价必须是非负数字，最多保留 2 位小数。");
  }

  return Number(value).toFixed(2);
}

export async function listResellerPackagePrices() {
  const { rows } = await dbQuery<ResellerPackagePrice>(
    `
      select
        prices.package_code,
        packages.name as package_name,
        prices.reseller_code,
        resellers.name as reseller_name,
        prices.supply_price,
        prices.created_at,
        prices.updated_at
      from reseller_package_prices prices
      join packages on packages.code = prices.package_code
      join resellers on resellers.code = prices.reseller_code
      order by
        resellers.is_active desc,
        resellers.sort_order asc,
        resellers.created_at asc,
        packages.is_active desc,
        packages.sort_order asc,
        packages.created_at asc
    `,
  );

  return rows;
}

export async function listActiveResellerPackagePriceOptions() {
  const { rows } = await dbQuery<ResellerPackagePriceOption>(
    `
      select
        prices.package_code,
        prices.reseller_code,
        prices.supply_price
      from reseller_package_prices prices
      join packages on packages.code = prices.package_code
      join resellers on resellers.code = prices.reseller_code
      where packages.is_active = true
        and resellers.is_active = true
    `,
  );

  return rows;
}

export async function upsertResellerPackagePrice(input: {
  packageCode: string;
  resellerCode: string;
  supplyPrice: string;
}) {
  const packageCode = normalizeCode(input.packageCode, "套餐类型");
  const resellerCode = normalizeCode(input.resellerCode, "下游对象");
  const supplyPrice = normalizeMoney(input.supplyPrice);

  const result = await dbQuery(
    `
      insert into reseller_package_prices (
        package_code,
        reseller_code,
        supply_price
      )
      select $1, $2, $3
      where exists (
        select 1
        from packages
        where code = $1
      )
        and exists (
          select 1
          from resellers
          where code = $2
        )
      on conflict (reseller_code, package_code)
      do update set supply_price = excluded.supply_price
      returning package_code
    `,
    [packageCode, resellerCode, supplyPrice],
  );

  if (result.rowCount === 0) {
    throw new Error("套餐类型或下游对象不存在。");
  }
}

export async function deleteResellerPackagePrice(input: {
  packageCode: string;
  resellerCode: string;
}) {
  const packageCode = normalizeCode(input.packageCode, "套餐类型");
  const resellerCode = normalizeCode(input.resellerCode, "下游对象");

  const result = await dbQuery(
    `
      delete from reseller_package_prices
      where package_code = $1
        and reseller_code = $2
      returning package_code
    `,
    [packageCode, resellerCode],
  );

  if (result.rowCount === 0) {
    throw new Error("供货价配置不存在。");
  }
}
