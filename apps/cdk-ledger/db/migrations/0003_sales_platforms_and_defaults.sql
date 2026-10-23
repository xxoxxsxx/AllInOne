begin;

alter table packages
  add column if not exists is_default boolean not null default false;

alter table resellers
  add column if not exists is_default boolean not null default false;

create table if not exists sales_platforms (
  code text primary key,
  name text not null,
  is_active boolean not null default true,
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz null,
  constraint sales_platforms_code_trimmed check (code = lower(trim(code))),
  constraint sales_platforms_code_present check (code <> ''),
  constraint sales_platforms_name_present check (trim(name) <> '')
);

alter table events
  add column if not exists platform_code text null references sales_platforms(code) on update restrict on delete restrict;

alter table events
  drop constraint if exists events_shape_valid;

alter table events
  add constraint events_platform_code_trimmed check (
    platform_code is null or platform_code = lower(trim(platform_code))
  );

alter table events
  add constraint events_shape_valid check (
    (
      event_type = 'issue_self'
      and package_code is not null
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
      and cdk is not null
      and related_cdk is not null
      and counterparty_code is null
    )
  );

drop trigger if exists sales_platforms_set_updated_at on sales_platforms;
create trigger sales_platforms_set_updated_at
before update on sales_platforms
for each row
execute function touch_updated_at();

create index if not exists sales_platforms_active_sort_idx
  on sales_platforms (is_active desc, sort_order asc, created_at asc);

create unique index if not exists packages_default_unique_idx
  on packages (is_default)
  where is_default = true;

create unique index if not exists resellers_default_unique_idx
  on resellers (is_default)
  where is_default = true;

create unique index if not exists sales_platforms_default_unique_idx
  on sales_platforms (is_default)
  where is_default = true;

create index if not exists events_platform_code_idx
  on events (platform_code);

commit;
