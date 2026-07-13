-- 0003: enable RLS on chunks (Supabase advisory: critical once any public key
-- exists). Deliberately NO policies: with RLS enabled and zero policies, anon
-- and authenticated roles are denied all access. All reads go through the
-- service-role key (which bypasses RLS) from server-only code; the browser
-- receives chunk data only via /api/ask responses. If a future feature needs
-- direct client reads, add an explicit read policy in a new migration.
alter table public.chunks enable row level security;
