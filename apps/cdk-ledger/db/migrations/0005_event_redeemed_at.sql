begin;

alter table events
  add column if not exists redeemed_at timestamptz null;

update events
set redeemed_at = occurred_at
where redeemed_at is null
  and event_type in ('issue_self', 'issue_reseller');

create index if not exists events_redeemed_at_idx
  on events (redeemed_at);

commit;
