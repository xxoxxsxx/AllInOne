begin;

alter table packages
  add column if not exists cost_price numeric(12,2) null,
  add column if not exists sale_price numeric(12,2) null;

alter table packages
  drop constraint if exists packages_cost_price_nonnegative,
  drop constraint if exists packages_sale_price_nonnegative;

alter table packages
  add constraint packages_cost_price_nonnegative check (
    cost_price is null or cost_price >= 0
  ),
  add constraint packages_sale_price_nonnegative check (
    sale_price is null or sale_price >= 0
  );

alter table sales_platforms
  add column if not exists fee_rate_percent numeric(7,4) not null default 0,
  add column if not exists fee_fixed_amount numeric(12,2) not null default 0;

alter table sales_platforms
  drop constraint if exists sales_platforms_fee_rate_nonnegative,
  drop constraint if exists sales_platforms_fee_fixed_nonnegative;

alter table sales_platforms
  add constraint sales_platforms_fee_rate_nonnegative check (fee_rate_percent >= 0),
  add constraint sales_platforms_fee_fixed_nonnegative check (fee_fixed_amount >= 0);

create table if not exists reseller_package_prices (
  reseller_code text not null references resellers(code) on update restrict on delete restrict,
  package_code text not null references packages(code) on update restrict on delete restrict,
  supply_price numeric(12,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz null,
  primary key (reseller_code, package_code),
  constraint reseller_package_prices_supply_nonnegative check (supply_price >= 0)
);

drop trigger if exists reseller_package_prices_set_updated_at on reseller_package_prices;
create trigger reseller_package_prices_set_updated_at
before update on reseller_package_prices
for each row
execute function touch_updated_at();

create index if not exists reseller_package_prices_package_idx
  on reseller_package_prices (package_code);

alter table events
  add column if not exists cost_price numeric(12,2) null,
  add column if not exists sale_price numeric(12,2) null,
  add column if not exists supply_price numeric(12,2) null,
  add column if not exists platform_fee_rate_percent numeric(7,4) null,
  add column if not exists platform_fee_fixed_amount numeric(12,2) null,
  add column if not exists platform_fee_amount numeric(12,2) null;

alter table events
  drop constraint if exists events_price_values_nonnegative,
  drop constraint if exists events_price_shape_valid;

alter table events
  add constraint events_price_values_nonnegative check (
    (cost_price is null or cost_price >= 0)
    and (sale_price is null or sale_price >= 0)
    and (supply_price is null or supply_price >= 0)
    and (platform_fee_rate_percent is null or platform_fee_rate_percent >= 0)
    and (platform_fee_fixed_amount is null or platform_fee_fixed_amount >= 0)
    and (platform_fee_amount is null or platform_fee_amount >= 0)
  ),
  add constraint events_price_shape_valid check (
    (
      cost_price is null
      and sale_price is null
      and supply_price is null
      and platform_fee_rate_percent is null
      and platform_fee_fixed_amount is null
      and platform_fee_amount is null
    )
    or (
      event_type = 'issue_self'
      and cost_price is not null
      and sale_price is not null
      and supply_price is null
      and platform_fee_rate_percent is not null
      and platform_fee_fixed_amount is not null
      and platform_fee_amount is not null
    )
    or (
      event_type = 'issue_reseller'
      and cost_price is not null
      and sale_price is null
      and supply_price is not null
      and (
        (
          platform_fee_rate_percent is null
          and platform_fee_fixed_amount is null
          and platform_fee_amount is null
        )
        or (
          platform_fee_rate_percent is not null
          and platform_fee_fixed_amount is not null
          and platform_fee_amount is not null
        )
      )
    )
  );

commit;
