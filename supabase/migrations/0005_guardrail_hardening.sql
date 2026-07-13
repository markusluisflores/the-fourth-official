-- 0005: guardrail hardening from the PR #16 review + Part 2b deploy blockers.
-- (1) record_question increments the global counter ONLY while the visitor is
--     within their daily cap — closes the griefing path where one visitor's
--     rejected requests burned the shared 500/day budget at zero cost.
--     The cap is a parameter so the constant keeps living in lib/rate-limit.ts.
-- (2) EXECUTE revoked from anon/authenticated on both RPCs — defense in depth
--     on top of deny-all RLS (service role keeps access; no anon key exists).
-- (3) search_path pinned on both functions (Supabase linter:
--     function_search_path_mutable).
create or replace function record_question(visitor_key text, visitor_limit int)
returns table (visitor_count int, global_count int)
language plpgsql
set search_path = public
as $$
declare
  v int;
  g int;
  today date := (now() at time zone 'utc')::date;
begin
  insert into usage_counters (day, scope, key, count)
  values (today, 'visitor', visitor_key, 1)
  on conflict (day, scope, key) do update set count = usage_counters.count + 1
  returning count into v;

  if v <= visitor_limit then
    insert into usage_counters (day, scope, key, count)
    values (today, 'global', 'global', 1)
    on conflict (day, scope, key) do update set count = usage_counters.count + 1
    returning count into g;
  else
    select coalesce(max(count), 0) into g
    from usage_counters
    where day = today and scope = 'global' and key = 'global';
  end if;

  return query select v, g;
end;
$$;

drop function if exists record_question(text);

revoke execute on function record_question(text, int) from anon, authenticated;
revoke execute on function match_chunks(vector, text, int, text) from anon, authenticated;
alter function match_chunks(vector, text, int, text) set search_path = public;
