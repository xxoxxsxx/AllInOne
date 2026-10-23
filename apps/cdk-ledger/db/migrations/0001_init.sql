begin;

create extension if not exists pgcrypto;

create or replace function normalize_cdk_value(input text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(upper(trim(coalesce(input, ''))), '\s+', '', 'g'), '')
$$;

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function normalize_event_fields()
returns trigger
language plpgsql
as $$
begin
  new.cdk = normalize_cdk_value(new.cdk);
  new.related_cdk = normalize_cdk_value(new.related_cdk);

  if new.note is not null then
    new.note = nullif(trim(new.note), '');
  end if;

  return new;
end;
$$;

create table if not exists packages (
  code text primary key,
  name text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz null,
  constraint packages_code_trimmed check (code = lower(trim(code))),
  constraint packages_code_present check (code <> ''),
  constraint packages_name_present check (trim(name) <> '')
);

create table if not exists resellers (
  code text primary key,
  name text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz null,
  constraint resellers_code_trimmed check (code = lower(trim(code))),
  constraint resellers_code_present check (code <> ''),
  constraint resellers_name_present check (trim(name) <> '')
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  occurred_at timestamptz not null,
  package_code text null references packages(code) on update restrict on delete restrict,
  cdk text null,
  related_cdk text null,
  counterparty_code text null references resellers(code) on update restrict on delete restrict,
  note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz null,
  constraint events_event_type_valid check (
    event_type in ('issue_self', 'issue_reseller', 'void', 'replace')
  ),
  constraint events_package_code_trimmed check (
    package_code is null or package_code = lower(trim(package_code))
  ),
  constraint events_counterparty_code_trimmed check (
    counterparty_code is null or counterparty_code = lower(trim(counterparty_code))
  ),
  constraint events_related_cdk_distinct check (
    related_cdk is null or cdk is distinct from related_cdk
  ),
  constraint events_shape_valid check (
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
  )
);

drop trigger if exists packages_set_updated_at on packages;
create trigger packages_set_updated_at
before update on packages
for each row
execute function touch_updated_at();

drop trigger if exists resellers_set_updated_at on resellers;
create trigger resellers_set_updated_at
before update on resellers
for each row
execute function touch_updated_at();

drop trigger if exists events_set_updated_at on events;
create trigger events_set_updated_at
before update on events
for each row
execute function touch_updated_at();

drop trigger if exists events_normalize_fields on events;
create trigger events_normalize_fields
before insert or update on events
for each row
execute function normalize_event_fields();

create index if not exists packages_active_sort_idx
  on packages (is_active desc, sort_order asc, created_at asc);

create index if not exists resellers_active_sort_idx
  on resellers (is_active desc, sort_order asc, created_at asc);

create index if not exists events_occurred_at_idx
  on events (occurred_at desc, created_at desc);

create index if not exists events_event_type_idx
  on events (event_type);

create index if not exists events_package_code_idx
  on events (package_code);

create index if not exists events_counterparty_code_idx
  on events (counterparty_code);

create index if not exists events_cdk_idx
  on events (cdk);

create index if not exists events_related_cdk_idx
  on events (related_cdk);

commit;
