// CDK 台账 SQLite schema：拍平自 apps/cdk-ledger/db/migrations/0001..0007 的最终形态。
//
// 类型映射：
// - uuid / text 主键 → TEXT（events.id 由应用层 crypto.randomUUID() 生成，DDL 不写 DEFAULT）；
// - timestamptz → TEXT（ISO8601 UTC 字符串，'Z' 后缀，毫秒精度，默认值用 strftime 生成）；
// - numeric → TEXT（十进制字符串，金额精度不丢；非负 CHECK 用 cast(x as numeric) 表达）；
// - boolean → INTEGER 0/1（读侧由 db.ts 按列名转换为 boolean，写侧 boolean 入参转 0/1）。
//
// 迁移覆盖对照：
// - 0001：packages/resellers/events 表、events 形状 CHECK、归一化触发器（归一化改在 TS 层）、普通索引；
// - 0002：events_type_occurred_cdk_unique_idx 部分唯一索引（CDK 去重，语义原样保留）；
// - 0003：is_default 列、sales_platforms 表、events.platform_code、default 唯一部分索引；
// - 0004：events_shape_valid 最终约束（platform_code 对 issue_self/replace 必填）；
// - 0005：redeemed_at 列及索引（历史数据回填不适用于新库，由 PG→SQLite 迁移脚本负责搬数据）；
// - 0006：packages 价格列、sales_platforms 手续费列、reseller_package_prices 表、事件价格快照列及其 CHECK；
// - 0007：refund 相关列、events_event_type_valid 加入 refund、events_refund_valid、events_shape_valid 的
//   refund 分支、events_source_event_idx 部分索引。
// PG 迁移中 NOT VALID 的历史语义（仅约束新增/修改行）无法在 SQLite 表达，新库全量生效即等价。

export const LEDGER_SCHEMA_SQL: string = `
create table if not exists packages (
  code text primary key not null,
  name text not null,
  is_active integer not null default 1 check (is_active in (0, 1)),
  is_default integer not null default 0 check (is_default in (0, 1)),
  sort_order integer not null default 0,
  cost_price text null,
  sale_price text null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text null,
  constraint packages_code_trimmed check (code = lower(trim(code))),
  constraint packages_code_present check (code <> ''),
  constraint packages_name_present check (trim(name) <> ''),
  constraint packages_cost_price_nonnegative check (cost_price is null or cast(cost_price as numeric) >= 0),
  constraint packages_sale_price_nonnegative check (sale_price is null or cast(sale_price as numeric) >= 0)
);

create table if not exists resellers (
  code text primary key not null,
  name text not null,
  is_active integer not null default 1 check (is_active in (0, 1)),
  is_default integer not null default 0 check (is_default in (0, 1)),
  sort_order integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text null,
  constraint resellers_code_trimmed check (code = lower(trim(code))),
  constraint resellers_code_present check (code <> ''),
  constraint resellers_name_present check (trim(name) <> '')
);

create table if not exists sales_platforms (
  code text primary key not null,
  name text not null,
  is_active integer not null default 1 check (is_active in (0, 1)),
  is_default integer not null default 0 check (is_default in (0, 1)),
  sort_order integer not null default 0,
  fee_rate_percent text not null default '0',
  fee_fixed_amount text not null default '0',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text null,
  constraint sales_platforms_code_trimmed check (code = lower(trim(code))),
  constraint sales_platforms_code_present check (code <> ''),
  constraint sales_platforms_name_present check (trim(name) <> ''),
  constraint sales_platforms_fee_rate_nonnegative check (cast(fee_rate_percent as numeric) >= 0),
  constraint sales_platforms_fee_fixed_nonnegative check (cast(fee_fixed_amount as numeric) >= 0)
);

create table if not exists reseller_package_prices (
  reseller_code text not null references resellers(code) on update restrict on delete restrict,
  package_code text not null references packages(code) on update restrict on delete restrict,
  supply_price text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text null,
  primary key (reseller_code, package_code),
  constraint reseller_package_prices_supply_nonnegative check (cast(supply_price as numeric) >= 0)
);

create table if not exists events (
  id text primary key not null,
  event_type text not null,
  occurred_at text not null,
  package_code text null references packages(code) on update restrict on delete restrict,
  platform_code text null references sales_platforms(code) on update restrict on delete restrict,
  cdk text null,
  related_cdk text null,
  counterparty_code text null references resellers(code) on update restrict on delete restrict,
  note text null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text null,
  redeemed_at text null,
  source_event_id text null references events(id) on delete restrict,
  refund_amount text null,
  cost_returned text null,
  fee_returned text null,
  cost_price text null,
  sale_price text null,
  supply_price text null,
  platform_fee_rate_percent text null,
  platform_fee_fixed_amount text null,
  platform_fee_amount text null,
  constraint events_event_type_valid check (
    event_type in ('issue_self', 'issue_reseller', 'void', 'replace', 'refund')
  ),
  constraint events_package_code_trimmed check (
    package_code is null or package_code = lower(trim(package_code))
  ),
  constraint events_platform_code_trimmed check (
    platform_code is null or platform_code = lower(trim(platform_code))
  ),
  constraint events_counterparty_code_trimmed check (
    counterparty_code is null or counterparty_code = lower(trim(counterparty_code))
  ),
  constraint events_related_cdk_distinct check (
    related_cdk is null or cdk is not related_cdk
  ),
  constraint events_shape_valid check (
    (event_type = 'refund' and cdk is not null and related_cdk is null and package_code is not null)
    or (
      event_type = 'issue_self'
      and package_code is not null
      and platform_code is not null
      and cdk is not null
      and related_cdk is null
      and counterparty_code is null
    )
    or (
      event_type = 'issue_reseller'
      and package_code is not null
      and cdk is not null
      and related_cdk is null
      and counterparty_code is not null
    )
    or (
      event_type = 'void'
      and package_code is null
      and platform_code is null
      and cdk is not null
      and related_cdk is null
      and counterparty_code is null
    )
    or (
      event_type = 'replace'
      and package_code is not null
      and platform_code is not null
      and cdk is not null
      and related_cdk is not null
      and counterparty_code is null
    )
  ),
  constraint events_refund_valid check (
    (event_type = 'refund' and source_event_id is not null and source_event_id <> id
      and refund_amount is not null and cast(refund_amount as numeric) >= 0
      and cost_returned is not null and cast(cost_returned as numeric) >= 0
      and fee_returned is not null and cast(fee_returned as numeric) >= 0
      and redeemed_at is null)
    or (event_type <> 'refund' and source_event_id is null
      and refund_amount is null and cost_returned is null and fee_returned is null)
  ),
  constraint events_price_values_nonnegative check (
    (cost_price is null or cast(cost_price as numeric) >= 0)
    and (sale_price is null or cast(sale_price as numeric) >= 0)
    and (supply_price is null or cast(supply_price as numeric) >= 0)
    and (platform_fee_rate_percent is null or cast(platform_fee_rate_percent as numeric) >= 0)
    and (platform_fee_fixed_amount is null or cast(platform_fee_fixed_amount as numeric) >= 0)
    and (platform_fee_amount is null or cast(platform_fee_amount as numeric) >= 0)
  ),
  constraint events_price_shape_valid check (
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
  )
);

-- 0002：CDK 去重唯一约束（部分索引）。
create unique index if not exists events_type_occurred_cdk_unique_idx
  on events (event_type, occurred_at, cdk)
  where cdk is not null;

create index if not exists packages_active_sort_idx
  on packages (is_active desc, sort_order asc, created_at asc);

create index if not exists resellers_active_sort_idx
  on resellers (is_active desc, sort_order asc, created_at asc);

create index if not exists sales_platforms_active_sort_idx
  on sales_platforms (is_active desc, sort_order asc, created_at asc);

create unique index if not exists packages_default_unique_idx
  on packages (is_default)
  where is_default = 1;

create unique index if not exists resellers_default_unique_idx
  on resellers (is_default)
  where is_default = 1;

create unique index if not exists sales_platforms_default_unique_idx
  on sales_platforms (is_default)
  where is_default = 1;

create index if not exists events_occurred_at_idx
  on events (occurred_at desc, created_at desc);

create index if not exists events_event_type_idx
  on events (event_type);

create index if not exists events_package_code_idx
  on events (package_code);

create index if not exists events_counterparty_code_idx
  on events (counterparty_code);

create index if not exists events_platform_code_idx
  on events (platform_code);

create index if not exists events_cdk_idx
  on events (cdk);

create index if not exists events_related_cdk_idx
  on events (related_cdk);

create index if not exists events_redeemed_at_idx
  on events (redeemed_at);

create index if not exists events_source_event_idx
  on events (source_event_id)
  where source_event_id is not null;

create index if not exists reseller_package_prices_package_idx
  on reseller_package_prices (package_code);

`;
