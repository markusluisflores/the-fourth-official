# Part 2a — Ask API & Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the server side of the Laws of the Game RAG app — a password-gated, rate-limited `POST /api/ask` route that retrieves rulebook chunks, generates a grounded answer with Claude's native citations, and streams it with a glass-box payload — plus the three tracked security/correctness pre-conditions and an eval harness upgrade that calibrates the relevance gate from data.

**Architecture:** Everything server-side; no UI (that is Part 2b, after a `design-process` session). Three small SQL migrations fix `match_chunks` correctness, lock down `chunks` with RLS, and add atomic usage counters. Four new `lib/` modules (session, rate-limit, answer, supabase) plus two route handlers and a middleware implement spec §6 (question flow) and §8 (guardrails). The eval harness gains gate metrics, an abstain set, and a paraphrase tier so `RELEVANCE_THRESHOLD` is set from a measured margin instead of one cricket probe.

**Tech Stack:** Next.js (App Router, TypeScript strict) · Supabase Postgres + pgvector (service-role only) · Voyage `voyage-4-lite` · `@anthropic-ai/sdk` with Claude Haiku 4.5 (`claude-haiku-4-5`, env-swappable) · Vitest.

**Spec:** `docs/superpowers/specs/2026-07-08-laws-rag-design.md` §6–§10. **Prior plan:** Part 1 (`2026-07-08-laws-rag-part1-ingestion-retrieval.md`) is merged scaffolding this builds on.

## Global Constraints

- **Branch off `main` after PR #1 is merged.** Branch name: `feat/ask-api-guardrails`.
- TypeScript strict mode; `npx tsc --noEmit`, `npm run lint`, `npm test`, and `npm run build` must pass before every commit (pre-commit hooks enforce most of this).
- All new logic lives in `lib/` or `supabase/migrations/`; route handlers in `app/api/`; **nothing else in `app/`** (UI is Part 2b).
- Tests live flat in `tests/*.test.ts` (Vitest). **No network calls in unit tests** — stub `fetch`, inject fake Supabase/Anthropic clients (Part 1 convention, see `.claude/agents/test-writer.md`).
- Secrets are server-side env vars only: existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`, plus new `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (optional, default `claude-haiku-4-5`), `DEMO_PASSWORD`, `SESSION_SECRET`. Never in client code, prompts, or commits.
- Guardrail values (spec §8, fixed for v1): question cap **300 chars**, per-visitor **20 questions/day**, global **500 questions/day**, retrieval **k = 8**.
- Generation: `max_tokens: 1024`, streaming always on, question goes in the **user message** (never concatenated into the system prompt — spec §9).
- Migrations are applied to the live Supabase project `the-fourth-official` (`moybkceeltzwnyiaasys`) via the Supabase MCP `apply_migration` tool, with the migration file committed to `supabase/migrations/` in the same commit.
- Risk tiers (spec §12): Tasks 4, 5, 6 are **Mandatory** (auth/rate-limit/spend-ceiling); Tasks 1, 2, 3, 7, 8 are **Standard**; Task 9 wraps up.
- Commits follow `~/.claude/standards/git-commit-standard.md`; commit after each task's final green step.

## Execution prerequisites (Markus, before Task 1)

1. **Merge PR #1** — this plan branches from `main` with Part 1 merged.
2. **Confirm `.env.local` exists** in the repo root (the Part 1 worktree that held it was deleted). If missing, recreate with the three Part 1 keys (Supabase dashboard → project settings → API; Voyage dashboard).
3. **Add the new secrets to `.env.local`:** `ANTHROPIC_API_KEY` (console.anthropic.com), `DEMO_PASSWORD` (pick one), `SESSION_SECRET` (run `openssl rand -base64 32` in Git Bash).
4. **Voyage free-tier note:** Task 3's full eval run makes ~46 embedding calls ≈ 16 minutes at 3 requests/minute. Fine to leave running.

## File Structure

```
supabase/migrations/
  0002_match_chunks_similarity_fix.sql   Task 1 — ORDER BY + true similarity for every returned row
  0003_chunks_rls.sql                    Task 2 — enable RLS on chunks (deny-all, service-role only)
  0004_usage_counters.sql                Task 6 — usage_counters table + record_question RPC
evals/
  run-evals.ts                           Task 3 — modify: gate metrics, abstain + paraphrase runs
  abstain-questions.json                 Task 3 — create: off-topic questions that must be gated
  paraphrase-questions.json              Task 3 — create: colloquial re-phrasings (informational tier)
lib/
  session.ts                             Task 4 — create: HMAC session tokens + constant-time password check
  supabase.ts                            Task 6 — create: shared server-side Supabase client (lazy singleton)
  rate-limit.ts                          Task 6 — create: visitor key + record_question wrapper + limits
  answer.ts                              Task 7 — create: document blocks, system prompt, streaming generator
  retrieval.ts                           Task 8 — modify: `server-only` guard, shared client, no other changes
app/api/
  session/route.ts                       Task 5 — create: POST password → session + visitor cookies
  ask/route.ts                           Task 8 — create: validate → rate-limit → retrieve → gate → stream
middleware.ts                            Task 5 — create: session check for /api/ask
tests/
  evals.test.ts                          Task 3 — modify: matchesExpected cases
  session.test.ts                        Task 4 — create
  session-route.test.ts                  Task 5 — create
  middleware.test.ts                     Task 5 — create
  rate-limit.test.ts                     Task 6 — create
  answer.test.ts                         Task 7 — create
  ask-route.test.ts                      Task 8 — create
  stubs/server-only.ts                   Task 8 — create: empty stub so Vitest can import server-only modules
```

---

### Task 1: Fix `match_chunks` — deterministic keyword lane + true similarity for every row

Two defects found in Fable's PR #1 review, both in `supabase/migrations/0001_chunks.sql`'s RPC:

1. The `kw` CTE applies `LIMIT 30` with no `ORDER BY` — SQL semantics make that "any 30 rows", and it only works today by planner accident.
2. `similarity` is `COALESCE`d to `0` for keyword-lane-only rows (tracked Part 2 pre-condition #3), which would make the relevance gate wrongly reject a keyword-only hit. Fix: compute `1 - (embedding <=> query_embedding)` in the outer SELECT for **every** returned row (8 extra distance computations — negligible).

**Files:**
- Create: `supabase/migrations/0002_match_chunks_similarity_fix.sql`

**Interfaces:**
- Consumes: existing `chunks` table and `match_chunks` signature (unchanged).
- Produces: `match_chunks(query_embedding vector(1024), query_text text, match_count int, version text)` returning the same columns, but `similarity` is now the true cosine similarity for every row, never a coalesced 0. `lib/retrieval.ts` needs no code change.

- [ ] **Step 1: Write the migration**

```sql
-- 0002: two correctness fixes to match_chunks, found in the Part 1 PR review.
-- (1) The kw CTE had LIMIT without ORDER BY — an arbitrary 30 rows per SQL
--     semantics; worked only because the planner happened to emit rows in the
--     window function's sort order. Now ordered explicitly.
-- (2) similarity was COALESCEd to 0 for rows found only by the keyword lane,
--     so the relevance gate would wrongly reject a keyword-only hit. Now the
--     outer SELECT computes true cosine similarity for every returned row
--     (at most match_count extra distance computations per query).
create or replace function match_chunks(
  query_embedding vector(1024),
  query_text text,
  match_count int default 8,
  version text default '2025-26'
) returns table (
  id bigint,
  law_number int,
  breadcrumb text,
  content text,
  similarity double precision,
  rrf_score double precision
) language sql stable as $$
  with vec as (
    select c.id,
           row_number() over (order by c.embedding <=> query_embedding) as rank
    from chunks c
    where c.corpus_version = version
    order by c.embedding <=> query_embedding
    limit 30
  ),
  kw as (
    select c.id,
           row_number() over (
             order by ts_rank(c.fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank
    from chunks c
    where c.corpus_version = version
      and c.fts @@ websearch_to_tsquery('english', query_text)
    order by rank
    limit 30
  ),
  fused as (
    select id,
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as rrf_score
    from vec v full outer join kw k using (id)
  )
  select c.id, c.law_number, c.breadcrumb, c.content,
         1 - (c.embedding <=> query_embedding) as similarity,
         f.rrf_score
  from fused f
  join chunks c on c.id = f.id
  order by f.rrf_score desc
  limit match_count;
$$;
```

- [ ] **Step 2: Apply to the live project**

Apply via the Supabase MCP tool: `apply_migration` with `project_id: "moybkceeltzwnyiaasys"`, name `match_chunks_similarity_fix`, and the SQL above.
Expected: success, no errors.

- [ ] **Step 3: Verify live behavior with a keyword-lane probe**

Run via Supabase MCP `execute_sql` (read-only sanity check that no returned row has similarity exactly 0 and rows are ordered by rrf_score):

```sql
select count(*) filter (where similarity = 0) as zero_sim_rows
from match_chunks(
  (select embedding from chunks limit 1),  -- any real embedding works as a probe
  'corner kick', 8, '2025-26');
```

Expected: `zero_sim_rows = 0`.

- [ ] **Step 4: Re-run the retrieval eval to confirm no regression**

Run: `npm run eval`
Expected: recall@8 still 30/30 = 100.0%; MRR ≥ 0.859 (ordering by rrf_score is unchanged for queries with ≤30 keyword matches, so numbers should be identical; any drop means the migration is wrong — stop and investigate). Takes ~10 min on the Voyage free tier.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0002_match_chunks_similarity_fix.sql
git commit -m "fix(retrieval): order keyword lane and return true similarity for all rows"
```

---

### Task 2: Enable RLS on `public.chunks` (deny-all — service-role access only)

Tracked pre-condition #1 (Supabase advisory: critical). **Decision (Fable, 2026-07-09): server-only access.** RLS is enabled with **zero policies**, which denies all access to the `anon` and `authenticated` roles. Every read goes through the service-role key from server-only code; the browser gets chunk data exclusively via `/api/ask`'s response. No anon key will exist in this app. (Task 9 records this as an ADR.)

**Files:**
- Create: `supabase/migrations/0003_chunks_rls.sql`

**Interfaces:**
- Consumes: `chunks` table.
- Produces: no API change — the service role bypasses RLS, so `lib/retrieval.ts` and the ingest CLI are unaffected.

- [ ] **Step 1: Write the migration**

```sql
-- 0003: enable RLS on chunks (Supabase advisory: critical once any public key
-- exists). Deliberately NO policies: with RLS enabled and zero policies, anon
-- and authenticated roles are denied all access. All reads go through the
-- service-role key (which bypasses RLS) from server-only code; the browser
-- receives chunk data only via /api/ask responses. If a future feature needs
-- direct client reads, add an explicit read policy in a new migration.
alter table public.chunks enable row level security;
```

- [ ] **Step 2: Apply to the live project**

Supabase MCP `apply_migration`, project `moybkceeltzwnyiaasys`, name `chunks_rls`.

- [ ] **Step 3: Verify**

1. Supabase MCP `get_advisors` (type `security`): the RLS-disabled finding for `chunks` is gone.
2. Run `npm run eval` quick check is NOT needed (service role bypasses RLS); instead run one live retrieval via Supabase MCP `execute_sql`: `select count(*) from chunks;` — should still return 118 (MCP uses privileged access).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0003_chunks_rls.sql
git commit -m "fix(security): enable RLS on chunks — deny-all, service-role reads only"
```

---

### Task 3: Eval harness v2 — gate metrics, abstain set, paraphrase tier, threshold calibration

The gate threshold (0.35) was sanity-checked with a single off-topic probe (0.309) — a 0.041 margin from one data point, with **no data** on on-topic `maxSimilarity`. Before `/api/ask` wires `isRelevant()` to real traffic, calibrate from a distribution. Also fixes the `scoreQuestion` prefix fragility from the PR review (a golden entry `"Law 1"` would match `"Law 10"`–`"Law 17"` breadcrumbs).

**⚠️ Markus input required:** review the abstain and paraphrase question sets (Step 4) for correctness before the measurement run, same as the Part 1 golden-set review.

**Files:**
- Modify: `evals/run-evals.ts`
- Create: `evals/abstain-questions.json`, `evals/paraphrase-questions.json`
- Modify: `lib/retrieval.ts` (only if calibration changes `RELEVANCE_THRESHOLD` — one constant)
- Test: `tests/evals.test.ts`

**Interfaces:**
- Consumes: `searchChunks(question, k)` → `{ chunks, maxSimilarity }` from `lib/retrieval.ts` (unchanged).
- Produces: `matchesExpected(breadcrumb: string, expected: string): boolean` and `scoreQuestion(chunks: {breadcrumb: string}[], expected: string[]): number` exported from `evals/run-evals.ts`. A calibrated `RELEVANCE_THRESHOLD` in `lib/retrieval.ts` with measurement evidence in the commit message.

- [ ] **Step 1: Write failing tests for segment-aware matching**

Append to `tests/evals.test.ts`:

```typescript
import { matchesExpected } from "../evals/run-evals";

describe("matchesExpected", () => {
  it("matches an exact breadcrumb", () => {
    expect(matchesExpected("Law 12 › 3", "Law 12 › 3")).toBe(true);
  });

  it("matches a section prefix followed by its title", () => {
    expect(matchesExpected("Law 12 › 3. Disciplinary action", "Law 12 › 3")).toBe(true);
  });

  it("matches a bare law prefix followed by a section separator", () => {
    expect(matchesExpected("Law 15 › 2. Infringements", "Law 15")).toBe(true);
  });

  // Regression for the PR #1 review finding: "Law 1" must NOT match Laws 10-17.
  it("does not match a longer law number sharing a digit prefix", () => {
    expect(matchesExpected("Law 11 › 1. Offside position", "Law 1")).toBe(false);
    expect(matchesExpected("Law 12 › 30. Hypothetical", "Law 12 › 3")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test`
Expected: FAIL — `matchesExpected` is not exported.

- [ ] **Step 3: Implement `matchesExpected` and rewire `scoreQuestion`**

In `evals/run-evals.ts`, replace the `scoreQuestion` body and add the helper:

```typescript
// Segment-aware prefix match: "Law 1" must match "Law 1 › ..." but never
// "Law 11 › ..." (PR #1 review finding — bare startsWith was digit-prefix unsafe).
export function matchesExpected(breadcrumb: string, expected: string): boolean {
  return (
    breadcrumb === expected ||
    breadcrumb.startsWith(expected + " ") ||
    breadcrumb.startsWith(expected + ".")
  );
}

export function scoreQuestion(chunks: { breadcrumb: string }[], expected: string[]): number {
  const idx = chunks.findIndex((c) => expected.some((e) => matchesExpected(c.breadcrumb, e)));
  return idx === -1 ? 0 : idx + 1;
}
```

Run: `npm test` — expected: PASS (all existing `scoreQuestion` tests must still pass unchanged).

- [ ] **Step 4: Create the abstain and paraphrase sets (Markus reviews before Step 6)**

`evals/abstain-questions.json` — clearly off-domain questions; a correct system gates all of them:

```json
[
  { "question": "What is the LBW rule in cricket?" },
  { "question": "How long is the shot clock in basketball?" },
  { "question": "Can you castle out of check in chess?" },
  { "question": "What temperature should I bake sourdough bread at?" },
  { "question": "How do I file my income tax return?" },
  { "question": "What is the three-second violation in the NBA?" }
]
```

`evals/paraphrase-questions.json` — colloquial re-phrasings of existing golden questions, **not** written from chunk text (this measures the self-authored-bias gap; informational tier, not part of the baseline defense):

```json
[
  { "question": "Can the keeper just hold onto the ball forever?", "expected": ["Law 12 › 3"] },
  { "question": "My mate says you can't be offside from a throw-in, is that true?", "expected": ["Law 11 › 3"] },
  { "question": "Does a goal count if it goes in straight from a throw?", "expected": ["Law 15"] },
  { "question": "Ball hit the ref and went in — does the goal stand?", "expected": ["Law 9"] },
  { "question": "How many subs do you get in a normal league game?", "expected": ["Law 3 › 2"] },
  { "question": "Is taping over your earrings enough or do they have to come off?", "expected": ["Law 4 › 1"] },
  { "question": "Who decides how much stoppage time gets added on?", "expected": ["Law 7 › 3"] },
  { "question": "Can you score an own goal directly from kick-off?", "expected": ["Law 8 › 1"] },
  { "question": "Where does the penalty spot sit and who's allowed to touch the ball first?", "expected": ["Law 14 › 1"] },
  { "question": "What happens if the keeper steps off his line early at a pen and it misses?", "expected": ["Law 14 › 2"] }
]
```

- [ ] **Step 5: Extend the runner with gate metrics and the two new sets**

Replace `evals/run-evals.ts`'s `main()` (keep `sleep`, `searchWithRetry`, `Golden`, and the exports above):

```typescript
interface AbstainQuestion {
  question: string;
}

async function runGoldenSet(
  label: string,
  goldens: Golden[],
): Promise<{ hits: number; mrrSum: number; maxSims: number[] }> {
  let hits = 0;
  let mrrSum = 0;
  const maxSims: number[] = [];
  for (const g of goldens) {
    const result = await searchWithRetry(g.question, 8);
    maxSims.push(result.maxSimilarity);
    const rank = scoreQuestion(result.chunks, g.expected);
    if (rank > 0) {
      hits += 1;
      mrrSum += 1 / rank;
    }
    console.log(
      `${rank > 0 ? `hit@${rank}` : "MISS "}  maxSim=${result.maxSimilarity.toFixed(3)}  ${g.question}`,
    );
  }
  console.log(
    `\n[${label}] recall@8: ${hits}/${goldens.length} = ${((hits / goldens.length) * 100).toFixed(1)}%` +
      `  MRR: ${(mrrSum / goldens.length).toFixed(3)}`,
  );
  return { hits, mrrSum, maxSims };
}

async function main() {
  const goldens: Golden[] = JSON.parse(await readFile("evals/golden-questions.json", "utf8"));
  const paraphrases: Golden[] = JSON.parse(
    await readFile("evals/paraphrase-questions.json", "utf8"),
  );
  const abstains: AbstainQuestion[] = JSON.parse(
    await readFile("evals/abstain-questions.json", "utf8"),
  );

  console.log("=== Golden set (baseline defense) ===");
  const golden = await runGoldenSet("golden", goldens);

  console.log("\n=== Paraphrase set (informational — self-authored-bias gap) ===");
  await runGoldenSet("paraphrase", paraphrases);

  console.log("\n=== Abstain set (should be gated) ===");
  const offTopicSims: number[] = [];
  for (const a of abstains) {
    const result = await searchWithRetry(a.question, 8);
    offTopicSims.push(result.maxSimilarity);
    console.log(`maxSim=${result.maxSimilarity.toFixed(3)}  ${a.question}`);
  }

  const minOnTopic = Math.min(...golden.maxSims);
  const maxOffTopic = Math.max(...offTopicSims);
  console.log("\n=== Gate calibration ===");
  console.log(`min on-topic maxSimilarity:  ${minOnTopic.toFixed(3)}`);
  console.log(`max off-topic maxSimilarity: ${maxOffTopic.toFixed(3)}`);
  console.log(
    minOnTopic > maxOffTopic
      ? `separable — midpoint threshold candidate: ${((minOnTopic + maxOffTopic) / 2).toFixed(3)}`
      : "NOT separable — tiers overlap; flag to Markus before choosing a threshold",
  );
}
```

Run: `npx tsc --noEmit` — expected: clean. `npm test` — expected: PASS (the runner's `main` is not unit-tested; only pure exports are).

- [ ] **Step 6: Run the full measurement (after Markus approves the question sets)**

Run: `npm run eval`
Expected output: golden recall@8 still 100%; paraphrase recall reported (any number is informative — record it); all 6 abstain questions listed with their maxSimilarity; a calibration verdict line. Takes ~16 min (46 Voyage calls at 3/min).

- [ ] **Step 7: Calibrate `RELEVANCE_THRESHOLD`**

If the sets are separable: set `RELEVANCE_THRESHOLD` in `lib/retrieval.ts` to the printed midpoint, rounded to 2 decimals, and update its comment to cite the measurement (e.g. `// calibrated 2026-07: min on-topic 0.41 vs max off-topic 0.31 over 30+6 questions`). If they overlap: **stop and ask Markus** — do not pick a value silently.

Run: `npm test` — expected: PASS (`tests/retrieval.test.ts` uses the constant relatively, so it passes for any value).

- [ ] **Step 8: Commit**

```bash
git add evals/ tests/evals.test.ts lib/retrieval.ts
git commit -m "feat(evals): gate metrics, abstain + paraphrase sets, calibrated threshold"
```

---

### Task 4: `lib/session.ts` — HMAC session tokens + constant-time password check [Mandatory tier]

The shared-password gate (spec §8). Stateless session: the cookie value is `issuedAt.HMAC-SHA256(SESSION_SECRET, issuedAt)` — no DB table, survives restarts, expires after 30 days. Uses **Web Crypto** (`crypto.subtle`) so the same code runs in Next.js middleware (Edge runtime — no Node `Buffer`/`crypto`) and in Node. Password comparison HMACs both sides then compares constant-time, so neither timing nor length leaks.

**Files:**
- Create: `lib/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: nothing project-internal. Secrets are passed as parameters (no `process.env` reads in this module — keeps it pure and testable).
- Produces:
  - `SESSION_COOKIE = "tfo_session"`, `VISITOR_COOKIE = "tfo_visitor"`, `SESSION_MAX_AGE_S: number`
  - `createSessionToken(secret: string, now?: number): Promise<string>`
  - `verifySessionToken(secret: string, token: string | undefined, now?: number): Promise<boolean>`
  - `passwordMatches(secret: string, submitted: string, actual: string): Promise<boolean>`

- [ ] **Step 1: Write failing tests**

Create `tests/session.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  passwordMatches,
  SESSION_MAX_AGE_S,
  verifySessionToken,
} from "../lib/session";

const SECRET = "test-secret-at-least-32-chars-long!!";

describe("session tokens", () => {
  it("round-trips a freshly created token", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken(SECRET, token)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken("other-secret-also-32-chars-long!!!!");
    expect(await verifySessionToken(SECRET, token)).toBe(false);
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken(SECRET);
    const [, sig] = token.split(".");
    expect(await verifySessionToken(SECRET, `${Date.now() - 9999}.${sig}`)).toBe(false);
  });

  it("rejects undefined, empty, and malformed tokens", async () => {
    expect(await verifySessionToken(SECRET, undefined)).toBe(false);
    expect(await verifySessionToken(SECRET, "")).toBe(false);
    expect(await verifySessionToken(SECRET, "no-dot-here")).toBe(false);
  });

  it("rejects an expired token", async () => {
    const issued = Date.now() - (SESSION_MAX_AGE_S * 1000 + 1);
    const token = await createSessionToken(SECRET, issued);
    expect(await verifySessionToken(SECRET, token)).toBe(false);
  });

  it("rejects a token issued in the future", async () => {
    const token = await createSessionToken(SECRET, Date.now() + 10 * 60_000);
    expect(await verifySessionToken(SECRET, token)).toBe(false);
  });
});

describe("passwordMatches", () => {
  it("accepts the correct password", async () => {
    expect(await passwordMatches(SECRET, "hunter2", "hunter2")).toBe(true);
  });

  it("rejects a wrong password, including different lengths", async () => {
    expect(await passwordMatches(SECRET, "hunter", "hunter2")).toBe(false);
    expect(await passwordMatches(SECRET, "HUNTER2", "hunter2")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `../lib/session`.

- [ ] **Step 3: Implement**

Create `lib/session.ts`:

```typescript
// Stateless HMAC sessions. Web Crypto only (no Node Buffer/crypto) so the same
// module runs in Edge middleware and in Node route handlers. Secrets are
// parameters, not process.env reads — callers own configuration.
export const SESSION_COOKIE = "tfo_session";
export const VISITOR_COOKIE = "tfo_visitor";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

const encoder = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  let bin = "";
  for (const byte of sig) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Constant-time string compare (both inputs are same-length HMAC outputs in
// every call site, so length is not an information leak here).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const payload = String(now);
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEqual(sig, await hmac(secret, payload))) return false;
  const issuedAt = Number(payload);
  if (!Number.isFinite(issuedAt)) return false;
  const ageMs = now - issuedAt;
  const clockSkewMs = 60_000;
  return ageMs < SESSION_MAX_AGE_S * 1000 && ageMs > -clockSkewMs;
}

// HMAC both sides, then constant-time compare — neither timing nor length of
// the real password leaks to the caller.
export async function passwordMatches(
  secret: string,
  submitted: string,
  actual: string,
): Promise<boolean> {
  return timingSafeEqual(await hmac(secret, submitted), await hmac(secret, actual));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/session.ts tests/session.test.ts
git commit -m "feat(auth): stateless HMAC session tokens with constant-time checks"
```

---

### Task 5: `POST /api/session` + middleware [Mandatory tier]

The gate: correct password → `Set-Cookie` with a session token **and** a random visitor ID (used by rate limiting; setting it at login guarantees `/api/ask` always sees it). Middleware rejects unauthenticated `/api/ask` calls before any work happens.

**Files:**
- Create: `app/api/session/route.ts`, `middleware.ts`
- Test: `tests/session-route.test.ts`, `tests/middleware.test.ts`
- Modify: `.env.local.example` (add the four new vars)

**Interfaces:**
- Consumes: `lib/session.ts` (Task 4). Env: `DEMO_PASSWORD`, `SESSION_SECRET`.
- Produces: `POST /api/session` accepting `{ "password": string }` → `204` with `tfo_session` + `tfo_visitor` cookies, or `401 { "error": "wrong password" }`. `middleware.ts` guarding the `/api/ask` matcher → `401 { "error": "unauthorized" }` without a valid session.

- [ ] **Step 1: Write failing tests**

Create `tests/session-route.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/session/route";

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/session", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

describe("POST /api/session", () => {
  beforeEach(() => {
    vi.stubEnv("DEMO_PASSWORD", "correct-horse");
    vi.stubEnv("SESSION_SECRET", "test-secret-at-least-32-chars-long!!");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sets session and visitor cookies on the right password", async () => {
    const res = await post({ password: "correct-horse" });
    expect(res.status).toBe(204);
    const setCookie = res.headers.getSetCookie().join(";");
    expect(setCookie).toContain("tfo_session=");
    expect(setCookie).toContain("tfo_visitor=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("rejects a wrong password with 401 and no cookies", async () => {
    const res = await post({ password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await post({ nope: true });
    expect(res.status).toBe(400);
  });
});
```

Create `tests/middleware.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { createSessionToken, SESSION_COOKIE } from "../lib/session";

const SECRET = "test-secret-at-least-32-chars-long!!";

const ask = (cookie?: string) => {
  const req = new NextRequest("http://localhost/api/ask", { method: "POST" });
  if (cookie) req.cookies.set(SESSION_COOKIE, cookie);
  return middleware(req);
};

describe("middleware", () => {
  beforeEach(() => vi.stubEnv("SESSION_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("passes through with a valid session cookie", async () => {
    const res = await ask(await createSessionToken(SECRET));
    expect(res.status).toBe(200); // NextResponse.next() reports 200
  });

  it("rejects a missing session cookie with 401", async () => {
    const res = await ask();
    expect(res.status).toBe(401);
  });

  it("rejects a forged session cookie with 401", async () => {
    const res = await ask("12345.not-a-real-signature");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve the route and middleware modules.

- [ ] **Step 3: Implement the route**

Create `app/api/session/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  passwordMatches,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  VISITOR_COOKIE,
} from "@/lib/session";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let password: unknown;
  try {
    ({ password } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (typeof password !== "string" || password.length === 0 || password.length > 200) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const secret = process.env.SESSION_SECRET!;
  if (!(await passwordMatches(secret, password, process.env.DEMO_PASSWORD!))) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }

  const res = new NextResponse(null, { status: 204 });
  const cookieOpts = { httpOnly: true, sameSite: "lax", secure: true, path: "/" } as const;
  res.cookies.set(SESSION_COOKIE, await createSessionToken(secret), {
    ...cookieOpts,
    maxAge: SESSION_MAX_AGE_S,
  });
  // Visitor ID feeds the per-visitor rate limit key. Set at login (not in
  // middleware) so /api/ask always sees it on the request, even the first one.
  if (!req.cookies.get(VISITOR_COOKIE)) {
    res.cookies.set(VISITOR_COOKIE, crypto.randomUUID(), {
      ...cookieOpts,
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
```

- [ ] **Step 4: Implement the middleware**

Create `middleware.ts` (repo root):

```typescript
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export const config = { matcher: ["/api/ask"] };

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const ok = await verifySessionToken(
    process.env.SESSION_SECRET!,
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}
```

- [ ] **Step 5: Teach Vitest the `@/` path alias**

The route and middleware import via `@/lib/...` (the `tsconfig.json` path alias), but Vitest does not read `tsconfig` paths — without this, this task's tests fail with "cannot resolve @/lib/session". Replace `vitest.config.ts`:

```typescript
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
```

- [ ] **Step 6: Update `.env.local.example`**

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
VOYAGE_API_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5
DEMO_PASSWORD=
SESSION_SECRET=
```

- [ ] **Step 7: Run tests + build to verify**

Run: `npm test` — expected: PASS.
Run: `npm run build` — expected: clean (middleware compiles for the Edge runtime; if `lib/session.ts` accidentally pulled in a Node-only API, this is where it fails).

- [ ] **Step 8: Commit**

```bash
git add app/api/session tests/session-route.test.ts tests/middleware.test.ts middleware.ts vitest.config.ts .env.local.example
git commit -m "feat(auth): password gate — session route and /api/ask middleware"
```

---

### Task 6: Usage counters — migration 0004 + `lib/rate-limit.ts` + `lib/supabase.ts` [Mandatory tier]

Spec §8: per-visitor 20/day, global 500/day, enforced atomically in Postgres (a single RPC increments both counters and returns both counts — race-safe under concurrent requests, one round-trip). Counting happens **before** any paid API call; a gated or failed question still counts (prevents free probing; simplest honest v1 semantics). Days are UTC.

**Files:**
- Create: `supabase/migrations/0004_usage_counters.sql`, `lib/supabase.ts`, `lib/rate-limit.ts`
- Test: `tests/rate-limit.test.ts`

**Interfaces:**
- Consumes: `@supabase/supabase-js` `SupabaseClient`; env `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (in `lib/supabase.ts` only).
- Produces:
  - `serverSupabase(): SupabaseClient` (lazy module-level singleton) from `lib/supabase.ts`
  - `VISITOR_DAILY_LIMIT = 20`, `GLOBAL_DAILY_LIMIT = 500`
  - `visitorKey(ip: string, visitorId: string): string` — sha256 hex, 32 chars
  - `recordQuestion(supabase: SupabaseClient, key: string): Promise<{ visitorCount: number; globalCount: number }>`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0004_usage_counters.sql`:

```sql
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
```

- [ ] **Step 2: Apply and verify live**

Supabase MCP `apply_migration`, project `moybkceeltzwnyiaasys`, name `usage_counters`. Then verify atomicity via `execute_sql`:

```sql
select * from record_question('smoke-test-key');
select * from record_question('smoke-test-key');
delete from usage_counters where key in ('smoke-test-key', 'global');
```

Expected: first call returns `(1, 1)`, second `(2, 2)`; cleanup removes the smoke rows.

- [ ] **Step 3: Write failing tests for the TS wrapper**

Create `tests/rate-limit.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordQuestion, visitorKey } from "../lib/rate-limit";

const fakeClient = (rpc: ReturnType<typeof vi.fn>) => ({ rpc }) as unknown as SupabaseClient;

describe("visitorKey", () => {
  it("is deterministic and 32 hex chars", () => {
    const a = visitorKey("1.2.3.4", "vis-1");
    expect(a).toBe(visitorKey("1.2.3.4", "vis-1"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs when either ip or visitor id differs", () => {
    expect(visitorKey("1.2.3.4", "vis-1")).not.toBe(visitorKey("1.2.3.5", "vis-1"));
    expect(visitorKey("1.2.3.4", "vis-1")).not.toBe(visitorKey("1.2.3.4", "vis-2"));
  });
});

describe("recordQuestion", () => {
  it("returns both counts from the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ visitor_count: 3, global_count: 41 }],
      error: null,
    });
    const counts = await recordQuestion(fakeClient(rpc), "some-key");
    expect(rpc).toHaveBeenCalledWith("record_question", { visitor_key: "some-key" });
    expect(counts).toEqual({ visitorCount: 3, globalCount: 41 });
  });

  it("throws with context when the RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(recordQuestion(fakeClient(rpc), "k")).rejects.toThrow(/record_question.*boom/);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `../lib/rate-limit`.

- [ ] **Step 5: Implement `lib/supabase.ts` and `lib/rate-limit.ts`**

Create `lib/supabase.ts`:

```typescript
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy module-level singleton — one client per server process instead of one
// per request (PR #1 review note). Server code only; Task 8 adds the
// server-only guard alongside retrieval's.
let client: SupabaseClient | null = null;

export function serverSupabase(): SupabaseClient {
  client ??= createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  return client;
}
```

Create `lib/rate-limit.ts`:

```typescript
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const VISITOR_DAILY_LIMIT = 20;
export const GLOBAL_DAILY_LIMIT = 500;

// Spec §8: keyed on IP + cookie. Hashed so raw IPs never land in the database.
export function visitorKey(ip: string, visitorId: string): string {
  return createHash("sha256").update(`${ip}:${visitorId}`).digest("hex").slice(0, 32);
}

export interface UsageCounts {
  visitorCount: number;
  globalCount: number;
}

export async function recordQuestion(
  supabase: SupabaseClient,
  key: string,
): Promise<UsageCounts> {
  const { data, error } = await supabase.rpc("record_question", { visitor_key: key });
  if (error) throw new Error(`record_question failed: ${error.message}`);
  const row = (data as { visitor_count: number; global_count: number }[])[0];
  return { visitorCount: row.visitor_count, globalCount: row.global_count };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0004_usage_counters.sql lib/supabase.ts lib/rate-limit.ts tests/rate-limit.test.ts
git commit -m "feat(guardrails): atomic daily usage counters and visitor keying"
```

---

### Task 7: `lib/answer.ts` — grounded generation with native citations

Spec §6.5: the 8 chunks go to Claude as **document content blocks with `citations: {enabled: true}`** — structured citations, not prompt-glued markers. Streaming always on. The module exposes a plain async generator of app-level events so the route (Task 8) just forwards them as SSE; the Anthropic client is injected for testability.

Reference (verified against the live citations doc, 2026-07-09): plain-text documents use `source: {type: "text", media_type: "text/plain", data}`; citations stream as `citations_delta` deltas inside `content_block_delta` events, each carrying one `char_location` citation (`document_index`, `cited_text`, `start_char_index`, `end_char_index`); a safety refusal surfaces as `stop_reason: "refusal"` on the final message (spec §9 requires an explicit branch for it).

**Files:**
- Create: `lib/answer.ts`
- Test: `tests/answer.test.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk`)

**Interfaces:**
- Consumes: `RetrievedChunk` from `lib/retrieval.ts`; env `ANTHROPIC_API_KEY` (read by the SDK), `ANTHROPIC_MODEL`.
- Produces (Part 2b's UI consumes these via the SSE contract in Task 8):

```typescript
export type AnswerEvent =
  | { type: "text"; delta: string }
  | {
      type: "citation";
      documentIndex: number; // index into the chunks array sent in the meta event
      citedText: string;
      startCharIndex: number;
      endCharIndex: number;
    }
  | { type: "refusal" } // Claude declined for safety reasons — show fallback copy
  | { type: "done"; citedDocumentIndexes: number[]; stopReason: string | null };

export function documentBlocks(chunks: RetrievedChunk[]): Anthropic.DocumentBlockParam[];
export function streamAnswer(
  question: string,
  chunks: RetrievedChunk[],
  client?: Anthropic,
): AsyncGenerator<AnswerEvent>;
```

- [ ] **Step 1: Install the SDK**

Run: `npm install @anthropic-ai/sdk`
Expected: added to `dependencies` in `package.json`.

- [ ] **Step 2: Write failing tests**

Create `tests/answer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { documentBlocks, streamAnswer, type AnswerEvent } from "../lib/answer";
import type { RetrievedChunk } from "../lib/retrieval";

const chunk = (id: number, breadcrumb: string): RetrievedChunk => ({
  id,
  law_number: 11,
  breadcrumb,
  content: `content of ${breadcrumb}`,
  similarity: 0.5,
  rrf_score: 0.03,
});

describe("documentBlocks", () => {
  it("maps each chunk to a citations-enabled plain-text document", () => {
    const blocks = documentBlocks([chunk(1, "Law 11 › 1. Offside position")]);
    expect(blocks).toEqual([
      {
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: "content of Law 11 › 1. Offside position",
        },
        title: "Law 11 › 1. Offside position",
        citations: { enabled: true },
      },
    ]);
  });
});

// A minimal fake of the SDK's MessageStream: async-iterable over raw stream
// events plus finalMessage(). Shapes match the Messages API streaming format.
function fakeStream(events: unknown[], stopReason: string) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield* events;
    },
    finalMessage: async () => ({ stop_reason: stopReason }),
  };
}

const textDelta = (text: string) => ({
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text },
});

const citationDelta = (documentIndex: number) => ({
  type: "content_block_delta",
  index: 0,
  delta: {
    type: "citations_delta",
    citation: {
      type: "char_location",
      cited_text: "cited words",
      document_index: documentIndex,
      document_title: "Law 11 › 1. Offside position",
      start_char_index: 0,
      end_char_index: 11,
    },
  },
});

const clientYielding = (events: unknown[], stopReason = "end_turn") =>
  ({
    messages: { stream: () => fakeStream(events, stopReason) },
  }) as unknown as Anthropic;

async function collect(gen: AsyncGenerator<AnswerEvent>): Promise<AnswerEvent[]> {
  const out: AnswerEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("streamAnswer", () => {
  const chunks = [chunk(1, "Law 11 › 1. Offside position"), chunk(2, "Law 15 › 1. Procedure")];

  it("yields text deltas, citations, and a done event with cited indexes", async () => {
    const events = await collect(
      streamAnswer(
        "q",
        chunks,
        clientYielding([textDelta("A player "), citationDelta(0), textDelta("is offside...")]),
      ),
    );
    expect(events).toEqual([
      { type: "text", delta: "A player " },
      {
        type: "citation",
        documentIndex: 0,
        citedText: "cited words",
        startCharIndex: 0,
        endCharIndex: 11,
      },
      { type: "text", delta: "is offside..." },
      { type: "done", citedDocumentIndexes: [0], stopReason: "end_turn" },
    ]);
  });

  it("deduplicates cited document indexes in done", async () => {
    const events = await collect(
      streamAnswer("q", chunks, clientYielding([citationDelta(1), citationDelta(1), citationDelta(0)])),
    );
    const done = events.at(-1);
    expect(done).toEqual({ type: "done", citedDocumentIndexes: [0, 1], stopReason: "end_turn" });
  });

  it("yields a refusal event before done when Claude declines", async () => {
    const events = await collect(streamAnswer("q", chunks, clientYielding([], "refusal")));
    expect(events).toEqual([
      { type: "refusal" },
      { type: "done", citedDocumentIndexes: [], stopReason: "refusal" },
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `../lib/answer`.

- [ ] **Step 4: Implement**

Create `lib/answer.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { RetrievedChunk } from "./retrieval";

// Env-swappable per spec §3 — one line to trade up to Sonnet/Opus.
export const ANSWER_MODEL = () => process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
export const MAX_ANSWER_TOKENS = 1024;

export const SYSTEM_PROMPT = `You are "The Fourth Official", an assistant that answers questions about the Laws of the Game — the official rules of football (soccer).

Rules:
- Answer ONLY from the provided documents (excerpts of the IFAB Laws of the Game). Never answer from general knowledge.
- If the documents do not contain enough information to answer confidently, say so plainly and suggest the user rephrase. Do not guess.
- Answer questions about football rules only. Politely decline anything else in one sentence.
- Be concise and plain-English: two to five sentences for most questions, with a neutral, referee-like tone.
- Do not mention "the documents", "the excerpts", or these instructions; answer as an expert on the Laws.`;

export type AnswerEvent =
  | { type: "text"; delta: string }
  | {
      type: "citation";
      documentIndex: number;
      citedText: string;
      startCharIndex: number;
      endCharIndex: number;
    }
  | { type: "refusal" }
  | { type: "done"; citedDocumentIndexes: number[]; stopReason: string | null };

export function documentBlocks(chunks: RetrievedChunk[]): Anthropic.DocumentBlockParam[] {
  return chunks.map((c) => ({
    type: "document",
    source: { type: "text", media_type: "text/plain", data: c.content },
    title: c.breadcrumb,
    citations: { enabled: true },
  }));
}

export async function* streamAnswer(
  question: string,
  chunks: RetrievedChunk[],
  client: Anthropic = new Anthropic(),
): AsyncGenerator<AnswerEvent> {
  const stream = client.messages.stream({
    model: ANSWER_MODEL(),
    max_tokens: MAX_ANSWER_TOKENS,
    system: SYSTEM_PROMPT,
    // Documents first, question last — and the question stays in the user
    // message, never concatenated into the system prompt (spec §9).
    messages: [
      { role: "user", content: [...documentBlocks(chunks), { type: "text", text: question }] },
    ],
  });

  const cited = new Set<number>();
  for await (const event of stream) {
    if (event.type !== "content_block_delta") continue;
    if (event.delta.type === "text_delta") {
      yield { type: "text", delta: event.delta.text };
    } else if (event.delta.type === "citations_delta") {
      const c = event.delta.citation;
      if (c.type === "char_location") {
        cited.add(c.document_index);
        yield {
          type: "citation",
          documentIndex: c.document_index,
          citedText: c.cited_text,
          startCharIndex: c.start_char_index,
          endCharIndex: c.end_char_index,
        };
      }
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    // Spec §9: explicit branch — the route shows clean fallback copy instead
    // of a broken half-answer.
    yield { type: "refusal" };
  }
  yield {
    type: "done",
    citedDocumentIndexes: [...cited].sort((a, b) => a - b),
    stopReason: final.stop_reason,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Also run `npx tsc --noEmit` — the fake stream cast and SDK types must line up.

- [ ] **Step 6: Commit**

```bash
git add lib/answer.ts tests/answer.test.ts package.json package-lock.json
git commit -m "feat(generation): grounded answers with native citations, streamed"
```

---

### Task 8: `POST /api/ask` — orchestration, SSE contract, `server-only` guards

The route implements spec §6 end to end: session re-check (defense in depth behind the middleware) → input validation → rate limiting → embed + hybrid search → relevance gate → streamed generation. Also lands tracked pre-condition #2: `import "server-only"` on the secret-bearing lib modules, now that a route imports them — with the tooling changes that keep `tsx` scripts and Vitest working.

**SSE contract (Part 2b's UI builds against exactly this):**

- Success: `200` `text/event-stream`. Events, in order: one `meta`, then interleaved `text` / `citation`, optionally one `refusal`, then exactly one `done`.
  - `event: meta` → `{ "chunks": RetrievedChunk[], "remaining": { "visitor": number } }` (all 8 chunks with true similarity + rrf_score — the glass-box payload)
  - `event: text` → `{ "type": "text", "delta": string }`
  - `event: citation` → `{ "type": "citation", "documentIndex": number, "citedText": string, "startCharIndex": number, "endCharIndex": number }` (`documentIndex` indexes into `meta.chunks`)
  - `event: refusal` → `{ "type": "refusal" }`
  - `event: done` → `{ "type": "done", "citedDocumentIndexes": number[], "stopReason": string | null }`
  - `event: error` → `{ "message": string }` (mid-stream failure; terminal)
- Relevance-gated: `200` JSON `{ "kind": "gated", "message": "I can only answer questions about the Laws of the Game.", "chunks": RetrievedChunk[], "maxSimilarity": number, "remaining": { "visitor": number } }` (no Claude call — spec §6.4; chunks still included so the glass-box panel can show *why* it gated).
- Rate-limited: `429` JSON `{ "kind": "rate_limited", "scope": "visitor" | "global", "message": string }`.
- Bad input: `400` JSON `{ "error": string }`. No session: `401` (middleware; the route also re-checks).
- Upstream failure before streaming starts: `502` JSON `{ "error": "something went wrong, please try again shortly" }`, logged server-side with context (spec §9).

**Files:**
- Create: `app/api/ask/route.ts`, `tests/stubs/server-only.ts`
- Modify: `lib/retrieval.ts` (add `server-only`, switch to `serverSupabase()`), `lib/supabase.ts`, `lib/rate-limit.ts`, `lib/answer.ts` (add `server-only`), `package.json` (script flags, `server-only` dep), `vitest.config.ts` (stub alias)
- Test: `tests/ask-route.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- Produces: the SSE contract above (frozen for Part 2b).

- [ ] **Step 1: Add the `server-only` guard and tooling**

1. `npm install server-only`
2. Add `import "server-only";` as line 1 of `lib/retrieval.ts`, `lib/supabase.ts`, `lib/rate-limit.ts`, `lib/answer.ts`. (Not `lib/session.ts` — the Edge middleware imports it, and it holds no secrets itself.)
3. In `lib/retrieval.ts`, replace the per-call `createClient(...)` with `serverSupabase()` from `./supabase` (PR #1 review note) — no other logic changes.
4. **`tsx` scripts:** the `server-only` package throws when imported outside a React server bundle. Node resolves its harmless variant under the `react-server` condition. Update `package.json` scripts:

```json
"ingest": "cross-env NODE_OPTIONS=\"--experimental-websocket --conditions=react-server\" tsx --env-file=.env.local scripts/ingest/index.ts",
"eval": "cross-env NODE_OPTIONS=\"--experimental-websocket --conditions=react-server\" tsx --env-file=.env.local evals/run-evals.ts"
```

5. **Vitest:** create `tests/stubs/server-only.ts` containing only `export {};` and alias it in `vitest.config.ts`:

```typescript
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
```

Run: `npm test` and `npm run eval -- --help 2>&1 | head -1` (or just start `npm run eval` and Ctrl-C after the first line) — expected: no `server-only` import crash in either.

- [ ] **Step 2: Write failing route tests**

Create `tests/ask-route.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AnswerEvent } from "../lib/answer";
import { createSessionToken, SESSION_COOKIE, VISITOR_COOKIE } from "../lib/session";

// Mock every server dependency before importing the route.
const searchChunks = vi.fn();
const recordQuestion = vi.fn();
const streamAnswer = vi.fn();
vi.mock("../lib/retrieval", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchChunks: (...args: unknown[]) => searchChunks(...args),
}));
vi.mock("../lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordQuestion: (...args: unknown[]) => recordQuestion(...args),
}));
vi.mock("../lib/answer", () => ({
  streamAnswer: (...args: unknown[]) => streamAnswer(...args),
}));
vi.mock("../lib/supabase", () => ({ serverSupabase: () => ({}) }));

import { POST } from "../app/api/ask/route";
import { RELEVANCE_THRESHOLD } from "../lib/retrieval";

const SECRET = "test-secret-at-least-32-chars-long!!";

const chunkRow = {
  id: 1,
  law_number: 11,
  breadcrumb: "Law 11 › 1. Offside position",
  content: "…",
  similarity: RELEVANCE_THRESHOLD + 0.2,
  rrf_score: 0.03,
};

async function post(body: unknown, withSession = true) {
  const req = new NextRequest("http://localhost/api/ask", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  if (withSession) req.cookies.set(SESSION_COOKIE, await createSessionToken(SECRET));
  req.cookies.set(VISITOR_COOKIE, "vis-1");
  return POST(req);
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  recordQuestion.mockResolvedValue({ visitorCount: 1, globalCount: 1 });
  searchChunks.mockResolvedValue({
    chunks: [chunkRow],
    maxSimilarity: chunkRow.similarity,
  });
  async function* fake(): AsyncGenerator<AnswerEvent> {
    yield { type: "text", delta: "Answer." };
    yield { type: "done", citedDocumentIndexes: [0], stopReason: "end_turn" };
  }
  streamAnswer.mockImplementation(() => fake());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/ask", () => {
  it("rejects a missing session with 401 even if middleware were bypassed", async () => {
    expect((await post({ question: "offside?" }, false)).status).toBe(401);
  });

  it("rejects a missing or over-length question with 400", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ question: "x".repeat(301) })).status).toBe(400);
    expect(recordQuestion).not.toHaveBeenCalled();
  });

  it("returns 429 with scope visitor when the visitor limit is exceeded", async () => {
    recordQuestion.mockResolvedValue({ visitorCount: 21, globalCount: 50 });
    const res = await post({ question: "offside?" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ kind: "rate_limited", scope: "visitor" });
    expect(searchChunks).not.toHaveBeenCalled();
  });

  it("returns 429 with scope global when the daily ceiling is hit", async () => {
    recordQuestion.mockResolvedValue({ visitorCount: 2, globalCount: 501 });
    const res = await post({ question: "offside?" });
    expect(await res.json()).toMatchObject({ kind: "rate_limited", scope: "global" });
  });

  it("returns the gated JSON response without calling Claude when below threshold", async () => {
    searchChunks.mockResolvedValue({
      chunks: [chunkRow],
      maxSimilarity: RELEVANCE_THRESHOLD - 0.05,
    });
    const res = await post({ question: "lbw in cricket?" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ kind: "gated" });
    expect(streamAnswer).not.toHaveBeenCalled();
  });

  it("streams meta, text, and done as SSE on the happy path", async () => {
    const res = await post({ question: "when is a player offside?" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: meta");
    expect(body).toContain('"remaining":{"visitor":19}');
    expect(body).toContain("event: text");
    expect(body).toContain('"delta":"Answer."');
    expect(body).toContain("event: done");
  });

  it("returns 502 with an honest message when retrieval fails before streaming", async () => {
    searchChunks.mockRejectedValue(new Error("voyage exploded"));
    const res = await post({ question: "offside?" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("try again") });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `../app/api/ask/route`.

- [ ] **Step 4: Implement the route**

Create `app/api/ask/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { streamAnswer } from "@/lib/answer";
import {
  GLOBAL_DAILY_LIMIT,
  recordQuestion,
  VISITOR_DAILY_LIMIT,
  visitorKey,
} from "@/lib/rate-limit";
import { isRelevant, searchChunks } from "@/lib/retrieval";
import { SESSION_COOKIE, verifySessionToken, VISITOR_COOKIE } from "@/lib/session";
import { serverSupabase } from "@/lib/supabase";

export const MAX_QUESTION_CHARS = 300;
const GATED_MESSAGE = "I can only answer questions about the Laws of the Game.";
const UPSTREAM_ERROR = "something went wrong, please try again shortly";

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function POST(req: NextRequest): Promise<Response> {
  // Defense in depth: the middleware already gates /api/ask, but a matcher
  // typo or config drift must not silently expose the paid path.
  const sessionOk = await verifySessionToken(
    process.env.SESSION_SECRET!,
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!sessionOk) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let question: unknown;
  try {
    ({ question } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (
    typeof question !== "string" ||
    question.trim().length === 0 ||
    question.length > MAX_QUESTION_CHARS
  ) {
    return NextResponse.json(
      { error: `question must be 1-${MAX_QUESTION_CHARS} characters` },
      { status: 400 },
    );
  }

  // Count before any paid call. A gated or failed question still consumes one —
  // simplest honest semantics, and it prevents free probing of the gate.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const visitorId = req.cookies.get(VISITOR_COOKIE)?.value ?? "no-cookie";
  let counts;
  try {
    counts = await recordQuestion(serverSupabase(), visitorKey(ip, visitorId));
  } catch (err) {
    console.error("rate-limit counter failed", { err });
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }
  if (counts.globalCount > GLOBAL_DAILY_LIMIT) {
    return NextResponse.json(
      {
        kind: "rate_limited",
        scope: "global",
        message: "The demo's daily budget is used up — please come back tomorrow.",
      },
      { status: 429 },
    );
  }
  if (counts.visitorCount > VISITOR_DAILY_LIMIT) {
    return NextResponse.json(
      {
        kind: "rate_limited",
        scope: "visitor",
        message: `You've used all ${VISITOR_DAILY_LIMIT} questions for today — come back tomorrow.`,
      },
      { status: 429 },
    );
  }
  const remaining = { visitor: Math.max(0, VISITOR_DAILY_LIMIT - counts.visitorCount) };

  let retrieval;
  try {
    retrieval = await searchChunks(question, 8);
  } catch (err) {
    console.error("retrieval failed", { question: question.slice(0, 80), err });
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }

  // Relevance gate (spec §6.4): off-topic and nonsense input never reaches
  // Claude. Chunks are still returned so the glass box can show why it gated.
  if (!isRelevant(retrieval)) {
    return NextResponse.json({
      kind: "gated",
      message: GATED_MESSAGE,
      chunks: retrieval.chunks,
      maxSimilarity: retrieval.maxSimilarity,
      remaining,
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(sse("meta", { chunks: retrieval.chunks, remaining })),
        );
        for await (const ev of streamAnswer(question as string, retrieval.chunks)) {
          controller.enqueue(encoder.encode(sse(ev.type, ev)));
        }
      } catch (err) {
        console.error("generation failed mid-stream", { question: (question as string).slice(0, 80), err });
        controller.enqueue(encoder.encode(sse("error", { message: UPSTREAM_ERROR })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 5: Run tests, type-check, lint, build**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green. (`console.error` is a warn-level lint hit under the current config, not an error — spec §9 requires server-side error logging, so it stays.)

- [ ] **Step 6: Live end-to-end smoke test**

With `.env.local` populated, run `npm run dev`, then in a second terminal (Git Bash):

```bash
# 1. Login and capture cookies
curl -s -c /tmp/tfo-cookies -X POST localhost:3000/api/session \
  -H "content-type: application/json" -d '{"password":"<DEMO_PASSWORD>"}' -o /dev/null -w "%{http_code}\n"
# expected: 204

# 2. Unauthenticated ask is rejected
curl -s -X POST localhost:3000/api/ask -H "content-type: application/json" \
  -d '{"question":"When is a player offside?"}' -o /dev/null -w "%{http_code}\n"
# expected: 401

# 3. Real question streams SSE with meta → text → done
curl -s -N -b /tmp/tfo-cookies -X POST localhost:3000/api/ask \
  -H "content-type: application/json" -d '{"question":"When is a player offside?"}'
# expected: event: meta with 8 chunks, streamed text deltas answering from Law 11,
#           at least one event: citation, event: done with citedDocumentIndexes

# 4. Off-topic question is gated without a Claude call
curl -s -b /tmp/tfo-cookies -X POST localhost:3000/api/ask \
  -H "content-type: application/json" -d '{"question":"What is the LBW rule in cricket?"}'
# expected: JSON {"kind":"gated",...}
```

Record the four outputs in the task notes (they go in the PR's test plan).

- [ ] **Step 7: Commit**

```bash
git add app/api/ask lib/ tests/ask-route.test.ts tests/stubs vitest.config.ts package.json package-lock.json
git commit -m "feat(api): /api/ask — gated, rate-limited, streamed answers with citations"
```

---

### Task 9: Wrap-up — hygiene, docs, ADR, reviews, PR

Close out the small PR #1 review findings, update the project docs, record the security-posture decision, and run the Mandatory-tier review battery before opening the PR.

**Files:**
- Modify: `package.json` (remove `dotenv`), `lib/voyage.ts` (fetch timeout), `CLAUDE.md` (runbook + commands + secrets), `docs/project-reviewer.md` (Part 2a talking points)
- Create: `docs/adr/0001-server-only-data-access.md` (via the `adr` skill's format)

- [ ] **Step 1: Hygiene fixes from the PR #1 review**

1. `npm uninstall dotenv` (declared but never imported — scripts use `tsx --env-file`).
2. In `lib/voyage.ts`, add a timeout so a hung Voyage request can't stall ingest or the API route forever — add to the `fetch` options: `signal: AbortSignal.timeout(30_000),`.

Run: `npm test` — expected: PASS (voyage tests stub fetch and ignore the signal).

- [ ] **Step 2: Update project docs**

In `CLAUDE.md`: add the four new env vars to the Secrets section; add `middleware.ts`, `app/api/`, and the three new migrations to the file-layout block; document the `--conditions=react-server` requirement on `ingest`/`eval` scripts (and why); note in the CI Runbook that `ci.yml` also has the `secret-scan` (gitleaks) job — it was added in Part 1's Task 9 fix but the runbook was never updated.

In `docs/project-reviewer.md`: add a Part 2a section — gate calibration numbers from Task 3 (min on-topic vs max off-topic maxSimilarity, chosen threshold), the paraphrase-tier recall (the honest answer to "how does it do on phrasing you didn't write?"), and one talking point on native citations vs prompt-glued `[1]` markers.

- [ ] **Step 3: Record the ADR**

Invoke the `adr` skill to record: **"Server-only data access: RLS deny-all + service-role + `server-only` imports."** Context: Part 2a needed a decision on anon-read vs server-only (tracked pre-condition #1). Decision: no anon key exists; `chunks` and `usage_counters` have RLS enabled with zero policies; all reads go through the service role from modules guarded by `import "server-only"`; the browser receives data exclusively through `/api/ask`. Consequences: no client-side Supabase SDK usage ever; a future feature needing direct client reads must add explicit policies in a new migration and revisit this ADR.

- [ ] **Step 4: Mandatory-tier review battery**

This branch contains auth, rate-limiting, and spend-ceiling code (Mandatory tier, spec §12):

1. Dispatch the **`security-reviewer`** agent (global) on the branch diff — focus: session forgery, timing attacks, rate-limit bypass (cookie deletion, IP spoofing via `x-forwarded-for`, parallel requests), cost-abuse paths, secret handling.
2. Run **`/security-review`** on the diff.
3. Dispatch the **`reviewer`** agent with this plan + spec §6–§9 for the standard quality pass.
4. Fix findings; re-run the relevant reviewer until clean or explicitly deferred with rationale.

Known accepted limitation to pre-empt (documented here so reviewers don't re-litigate): `x-forwarded-for` is client-influenced; a determined attacker can rotate visitor keys. The **global** ceiling (500/day ≈ $2.50 worst case) is the real spend bound; the visitor limit is a fairness mechanism, not a security boundary.

- [ ] **Step 5: Verify everything, then open the PR**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Then follow the global workflow: `pre-pr-review` skill → `commit-commands:commit-push-pr`. PR title: `feat: Part 2a — ask API, guardrails, and gate calibration`. Test plan: unit counts, the four smoke-test outputs from Task 8 Step 6, eval numbers from Task 3.

---

## Deferred to Part 2b (UI + deploy — planned after a `design-process` session)

- Gate screen + Ask screen + glass-box panel (spec §7) consuming the Task 8 SSE contract.
- Railway deploy, env configuration, `README.md` rewrite (it is still create-next-app boilerplate — the repo's landing page), `app/layout.tsx` metadata.
- Manual QA smoke list (spec §10) — needs the UI.

## Known future work (not 2a, not 2b — tracked)

- **HNSW post-filtering:** when a second `corpus_version` is ingested (next season), the vector lane's version filter is applied after the index scan and can silently return fewer than 30 rows. Options: pgvector iterative index scans (v0.8+, available on Supabase), a partial index per version, or deleting superseded versions. Revisit at the first multi-version ingest.
- `match_count` is uncapped in SQL; the route pins `k=8` server-side, so exposure requires a route bug. Consider a SQL-side clamp if the RPC ever gets another caller.

## Self-review notes (spec coverage)

- §6.1 validate → Task 5 (middleware) + Task 8 (session re-check, length cap). §6.2 embed → existing `searchChunks`. §6.3 hybrid RPC → Task 1 fixes. §6.4 gate → Task 8, threshold calibrated in Task 3. §6.5 generate (Haiku, citations enabled, question in user message, streaming) → Task 7. §6.6 respond (streamed + glass-box + cited flags) → Task 8 SSE contract.
- §8 guardrails: password → Tasks 4-5; per-visitor + global limits → Task 6 + Task 8 ordering; input cap → Task 8.
- §9: corpus injection structurally absent (unchanged); question injection bounded (no tools, no secrets in context, output only to the asker); Voyage/Claude failure → honest 502/`error` event + server logs; refusal stop_reason → Task 7; gate message → Task 8.
- §10: unit tests per task; eval harness extended in Task 3; manual QA deferred to 2b (needs UI).
- Pre-conditions: #1 RLS → Task 2; #2 server-only → Task 8; #3 similarity-0 → Task 1.
