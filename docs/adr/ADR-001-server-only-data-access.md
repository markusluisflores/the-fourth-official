# ADR-001: Server-only data access — RLS deny-all + service-role + server-only imports

**Date:** 2026-07-12
**Status:** Accepted

## Context and Problem Statement

Part 2a needed to decide whether `chunks` (and later `usage_counters`) should
be readable directly from the browser via a Supabase anon key, or exclusively
through server-side code. This determines the RLS policy design for both
tables and whether any client-side Supabase SDK usage is ever introduced into
the app. Supabase's own security advisories flag RLS-disabled tables as a
critical finding once any public key exists for a project (tracked as Part 2
pre-condition #1).

## Decision Drivers

* This is a public demo app — minimize the credential surface shipped to the browser
* Supabase flags RLS-disabled tables as critical the moment any public/anon key exists, regardless of whether that key is actually used to read sensitive data
* The retrieval pipeline (`lib/retrieval.ts`) already used the service-role key exclusively in Part 1 — no anon-key path exists yet to preserve
* Guardrails (per-visitor/global rate limits, the relevance gate, password-gated sessions) only work if all data access is mediated by server code that can enforce them; a direct client-to-Supabase path would bypass all of it

## Considered Options

* Anon key with read-only RLS policies on `chunks` (the rulebook text itself isn't sensitive, so a public-read policy is defensible)
* Server-only access — RLS enabled with zero policies on `chunks` and `usage_counters`, no anon key ever shipped

## Decision Outcome

**Chosen: Server-only access** — because it closes off an entire class of guardrail-bypass risk (rate limits, relevance gate, session auth) for zero functional cost, since nothing in this app currently needs a direct client read.

`chunks` (migration `0003_chunks_rls.sql`) and `usage_counters` (migration
`0004_usage_counters.sql`) both have row level security enabled with **zero
policies** — this denies all access to the `anon` and `authenticated` roles.
No anon key exists anywhere in this app. Every read goes through the
service-role key, used only from server-side modules explicitly guarded by
`import "server-only"` (`lib/retrieval.ts`, `lib/supabase.ts`,
`lib/rate-limit.ts`, `lib/answer.ts`) so a build-time check catches any
accidental client-bundle inclusion, not just a runtime one. The browser
receives chunk data exclusively through `/api/ask`'s streamed response (the
`meta` event's glass-box payload), never via a direct Supabase query.

### Consequences

* ✅ No anon key ever needs to be generated, rotated, or exposed to the client — the browser's credential surface for Supabase is zero
* ✅ Guardrails are structurally impossible to bypass by querying Supabase directly, since the browser has no network path to it at all
* ✅ `server-only` import guards catch accidental client-bundle inclusion at build time, not just at request time
* ⚠️ A future feature needing direct client-side reads (e.g. a public read-only "browse the rulebook" page that skips the API route) requires adding explicit RLS policies in a new migration and revisiting this decision
* ⚠️ Every new data-access path — even for data that would be safe to expose publicly — must go through a server route; there is no shortcut via the Supabase client SDK from the browser
