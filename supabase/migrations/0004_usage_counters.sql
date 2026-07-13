-- 0004: daily usage counters for the per-visitor and global question limits
-- (spec §8). One RPC increments both counters atomically and returns both new
-- counts — race-safe under concurrent requests, one round-trip. Days are UTC.
create table if not exists usage_counters (
  day date not null,
  scope text not null check (scope in ('visitor', 'global')),
  key text not null,
  count int not null default 0,
  primary key (day, scope, key)
);

-- Same posture as chunks (migration 0003): RLS on, zero policies — service
-- role only.
alter table usage_counters enable row level security;

create or replace function record_question(visitor_key text)
returns table (visitor_count int, global_count int)
language plpgsql as $$
declare
  v int;
  g int;
  today date := (now() at time zone 'utc')::date;
begin
  insert into usage_counters (day, scope, key, count)
  values (today, 'visitor', visitor_key, 1)
  on conflict (day, scope, key) do update set count = usage_counters.count + 1
  returning count into v;

  insert into usage_counters (day, scope, key, count)
  values (today, 'global', 'global', 1)
  on conflict (day, scope, key) do update set count = usage_counters.count + 1
  returning count into g;

  return query select v, g;
end;
$$;
