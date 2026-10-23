begin;

alter table events
  drop constraint if exists events_shape_valid;

alter table events
  add constraint events_shape_valid check (
    (
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
