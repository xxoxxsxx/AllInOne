begin;

alter table events
  add column if not exists source_event_id uuid references events(id) on delete restrict,
  add column if not exists refund_amount numeric(12,2),
  add column if not exists cost_returned numeric(12,2),
  add column if not exists fee_returned numeric(12,2);

alter table events drop constraint if exists events_event_type_valid;
alter table events add constraint events_event_type_valid
  check (event_type in ('issue_self', 'issue_reseller', 'void', 'replace', 'refund'));

alter table events drop constraint if exists events_refund_valid;
alter table events add constraint events_refund_valid check (
  (event_type = 'refund' and source_event_id is not null and source_event_id <> id
    and refund_amount is not null and refund_amount >= 0
    and cost_returned is not null and cost_returned >= 0
    and fee_returned is not null and fee_returned >= 0
    and redeemed_at is null)
  or (event_type <> 'refund' and source_event_id is null
    and refund_amount is null and cost_returned is null and fee_returned is null)
);

create index if not exists events_source_event_idx on events (source_event_id)
  where source_event_id is not null;

alter table events
  drop constraint if exists events_shape_valid;

alter table events
  add constraint events_shape_valid check (
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
  ) not valid;

commit;
