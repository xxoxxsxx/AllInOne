begin;

do $$
begin
  if exists (
    select 1
    from (
      select event_type, occurred_at, cdk
      from events
      where cdk is not null
      group by event_type, occurred_at, cdk
      having count(*) > 1
    ) as duplicates
  ) then
    raise exception
      'Duplicate events already exist for the same event_type + occurred_at + cdk. Clean existing data before applying 0002_event_dedup.sql.';
  end if;
end;
$$;

create unique index if not exists events_type_occurred_cdk_unique_idx
  on events (event_type, occurred_at, cdk)
  where cdk is not null;

commit;
