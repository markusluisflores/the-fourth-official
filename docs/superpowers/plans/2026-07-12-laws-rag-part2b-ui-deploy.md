# Part 2b — UI & Railway Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship The Fourth Official's first user-facing surface — gate + ask screens on Part 2a's frozen SSE contract — plus the Mandatory guardrail hardening and a Railway production deploy.

**Architecture:** Two routes (`/gate`, `/`) rendered by thin client components; all streaming/citation/state logic lives in pure `lib/` functions (unit-testable, no React). The Part 2a API is consumed as-is (no contract changes). Server ride-alongs: proxy rename + page gating, migration `0005` (counter ordering + RPC hardening), HMAC domain separation, SSE cancel, and the trusted-XFF fix which is finalized only after a live probe on Railway.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts` convention) · Tailwind 4 (`@theme` tokens) · Geist Sans/Mono · Vitest · Supabase MCP for migrations · Railway MCP for deploy.

**Spec:** `docs/superpowers/specs/2026-07-12-laws-rag-part2b-ui-deploy-design.md` (approved 2026-07-12). Visual decisions: `docs/superpowers/specs/mockups/2026-07-12-part2b-ui-mockup.md` (Q1–Q5, all decided) + `…-palette.pdf` (v2, source of truth for hex values).

## Global Constraints

- **Prerequisite: PR #16 is merged.** Branch off updated `main`: `feat/ui-deploy`.
- `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` green before every commit.
- **Every UI task (8, 9) invokes the built-in `frontend-design` skill before writing components** (design-process handoff rule, 2026-07-12).
- Components stay thin; anything with branching logic lives in `lib/` as pure functions with Vitest tests. No network in unit tests (Part 1/2a convention).
- **No raw hex in components** — colors only via the `@theme` tokens Task 1 defines.
- Copy: reuse API strings verbatim; new copy is plain, referee-neutral, no exclamation marks.
- Palette v2 (spec §3): bg `#FFFFFF`/`#0A0A0A`, fg `#171717`/`#EDEDED`, accent `#15803D` light / `#22C55E` dark, yellow-card fill `#FACC15` (fill only, never text), red-card fill `#DC2626`, error text on dark `#F87171`.
- Next.js 16 file conventions differ from training data — consult `node_modules/next/dist/docs/` before writing route/proxy code (AGENTS.md rule). The `proxy.ts` convention is already verified: root-level file exporting a function named `proxy` plus optional `config.matcher`.
- Migrations: applied to live Supabase project `the-fourth-official` (`moybkceeltzwnyiaasys`) via Supabase MCP `apply_migration`, with the SQL file committed in the same commit.
- Risk tiers (spec §10): Tasks 3, 4, 5, 10 **Mandatory**; Tasks 2, 6, 7, 8, 9 **Standard**; Tasks 1, 11 **Routine**. Mandatory-tier review battery before the PR (Task 11).
- Guardrail values unchanged: 300 chars, 20/visitor/day, 500/global/day, k=8, threshold 0.35.

## File Structure

```
app/
  globals.css                 Task 1 — modify: palette v2 @theme tokens, Geist fix
  layout.tsx                  Task 1 — modify: real metadata
  icon.svg                    Task 1 — create: two-card favicon
  gate/page.tsx               Task 8 — create: gate route
  page.tsx                    Task 9 — replace scaffold: ask route
proxy.ts                      Task 5 — rename from middleware.ts + page gating
lib/
  constants.ts                Task 2 — create: MAX_QUESTION_CHARS
  answer.ts                   Task 2 — modify: abort upstream on early exit
  session.ts                  Task 3 — modify: HMAC domain prefixes
  rate-limit.ts               Task 4 — modify: visitor_limit param; Task 10: trustedClientIp
  sse-client.ts               Task 6 — create: incremental SSE parser
  ask-stream.ts               Task 7 — create: ask state machine reducer
  glass-constants.ts          Task 9 — create: client-side RELEVANCE_THRESHOLD mirror
components/
  GateForm.tsx                Task 8
  AskForm.tsx  RulingCard.tsx  LawPassages.tsx  GlassBox.tsx
  HistoryList.tsx  RemainingBadge.tsx  CardBadge.tsx      Task 9
hooks/
  useAskStream.ts             Task 9
app/api/ask/route.ts          Task 2 (constants+cancel), Task 10 (trusted IP)
supabase/migrations/0005_guardrail_hardening.sql   Task 4
tests/
  answer.test.ts (modify)  session.test.ts (modify)  rate-limit.test.ts (modify)
  proxy.test.ts (rename from middleware.test.ts)  sse-client.test.ts (create)
  ask-stream.test.ts (create)  ask-route.test.ts (modify)
README.md  CLAUDE.md  NEXT-SESSION.md (delete)      Task 11
```

---

### Task 1: Palette tokens, metadata, favicon [Routine]

**Files:**
- Modify: `app/globals.css`
- Modify: `app/layout.tsx:15-18`
- Create: `app/icon.svg`

**Interfaces:**
- Produces: Tailwind color utilities `bg-accent`, `text-accent`, `text-accent-contrast`, `bg-card-yellow`, `bg-card-red`, `text-error` used by Tasks 8–9. Font vars already wired by scaffold.

- [ ] **Step 1: Replace `app/globals.css` with the token system**

```css
@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #171717;
  --accent: #15803d;
  --accent-contrast: #ffffff;
  --card-yellow: #facc15;
  --card-red: #dc2626;
  --error-text: #dc2626;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #ededed;
    --accent: #22c55e;
    --accent-contrast: #052e16;
    --error-text: #f87171;
  }
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-accent: var(--accent);
  --color-accent-contrast: var(--accent-contrast);
  --color-card-yellow: var(--card-yellow);
  --color-card-red: var(--card-red);
  --color-error: var(--error-text);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

body {
  background: var(--background);
  color: var(--foreground);
  /* Part 2b fix: the scaffold hardcoded Arial here, overriding the Geist
     variables layout.tsx already wires up. */
  font-family: var(--font-geist-sans), Arial, Helvetica, sans-serif;
}
```

- [ ] **Step 2: Replace the metadata export in `app/layout.tsx`**

```tsx
export const metadata: Metadata = {
  title: "The Fourth Official",
  description:
    "Football rules Q&A grounded in the IFAB Laws of the Game — every answer cites the exact law passage it comes from.",
};
```

- [ ] **Step 3: Create `app/icon.svg`** (Next.js picks this up as the favicon automatically)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="6" y="7" width="12" height="17" rx="2" fill="#DC2626" transform="rotate(-12 12 15)"/>
  <rect x="14" y="6" width="12" height="17" rx="2" fill="#FACC15" transform="rotate(8 20 14)"/>
</svg>
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all green; build output unchanged except the new icon route.

- [ ] **Step 5: Commit**

```bash
git add app/globals.css app/layout.tsx app/icon.svg
git commit -m "feat(ui): referee's-kit design tokens, real metadata, card favicon"
```

---

### Task 2: Shared constant + SSE cancel/abort [Standard]

**Files:**
- Create: `lib/constants.ts`
- Modify: `lib/answer.ts` (abort upstream on early exit)
- Modify: `app/api/ask/route.ts` (import constant; `cancel()` handler)
- Test: `tests/answer.test.ts`, `tests/ask-route.test.ts`

**Interfaces:**
- Produces: `MAX_QUESTION_CHARS = 300` from `lib/constants.ts` (Task 9's `AskForm` imports it; the route imports it instead of defining it).
- `streamAnswer` signature unchanged; new behavior: if the consumer stops iterating early (generator `return()`), the underlying Anthropic stream is aborted.

- [ ] **Step 1: Write the failing tests**

Append to `tests/answer.test.ts`:

```typescript
it("aborts the underlying stream when the consumer stops early", async () => {
  const abort = vi.fn();
  const neverEnding = {
    [Symbol.asyncIterator]: async function* () {
      yield textDelta("first ");
      yield textDelta("second ");
      yield textDelta("third ");
    },
    finalMessage: async () => ({ stop_reason: "end_turn" }),
    abort,
  };
  const client = { messages: { stream: () => neverEnding } } as unknown as Anthropic;
  const gen = streamAnswer("q", chunks, client);
  await gen.next(); // consume one event
  await gen.return(undefined as never); // consumer walks away
  expect(abort).toHaveBeenCalledOnce();
});

it("does not abort the stream after normal completion", async () => {
  const abort = vi.fn();
  const finite = {
    [Symbol.asyncIterator]: async function* () {
      yield textDelta("done");
    },
    finalMessage: async () => ({ stop_reason: "end_turn" }),
    abort,
  };
  const client = { messages: { stream: () => finite } } as unknown as Anthropic;
  await collect(streamAnswer("q", chunks, client));
  expect(abort).not.toHaveBeenCalled();
});
```

(`vi` needs importing at the top of the file: `import { describe, expect, it, vi } from "vitest";`)

Append to `tests/ask-route.test.ts`:

```typescript
it("stops consuming the generator when the client disconnects", async () => {
  let generatorFinallyRan = false;
  async function* slow(): AsyncGenerator<AnswerEvent> {
    try {
      yield { type: "text", delta: "a" };
      yield { type: "text", delta: "b" };
      yield { type: "text", delta: "c" };
    } finally {
      generatorFinallyRan = true;
    }
  }
  streamAnswer.mockImplementation(() => slow());
  const res = await post({ question: "when is a player offside?" });
  const reader = res.body!.getReader();
  await reader.read(); // meta
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 10));
  expect(generatorFinallyRan).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test`
Expected: FAIL — `abort` never called; `generatorFinallyRan` false.

- [ ] **Step 3: Create `lib/constants.ts`**

```typescript
// Shared between the API route (validation) and the UI (input maxLength +
// character counter). Guardrail value fixed by spec §8.
export const MAX_QUESTION_CHARS = 300;
```

- [ ] **Step 4: Update `lib/answer.ts`**

The Anthropic SDK's `MessageStream` exposes `.abort()`. Wrap the iteration so an early generator exit aborts upstream, but a completed run does not:

```typescript
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

  let finished = false;
  try {
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
    finished = true;
    yield {
      type: "done",
      citedDocumentIndexes: [...cited].sort((a, b) => a - b),
      stopReason: final.stop_reason,
    };
  } finally {
    // Consumer walked away (client disconnect) — stop paying for tokens.
    if (!finished) stream.abort();
  }
}
```

Type note: the fake in tests needs `abort` on the stream object; the SDK type has it, so `clientYielding` in `tests/answer.test.ts` must add `abort: () => {}` to its `fakeStream` return (do it while you're there — existing tests keep passing).

- [ ] **Step 5: Update `app/api/ask/route.ts`**

Replace the `MAX_QUESTION_CHARS` export with an import, and add cancellation:

```typescript
import { MAX_QUESTION_CHARS } from "@/lib/constants";
```

(delete the `export const MAX_QUESTION_CHARS = 300;` line)

Replace the `ReadableStream` block:

```typescript
  const encoder = new TextEncoder();
  let cancelled = false;
  const gen = streamAnswer(question as string, retrieval.chunks);
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(sse("meta", { chunks: retrieval.chunks, remaining })));
        for await (const ev of gen) {
          if (cancelled) break;
          controller.enqueue(encoder.encode(sse(ev.type, ev)));
        }
      } catch (err) {
        if (!cancelled) {
          console.error("generation failed mid-stream", {
            question: (question as string).slice(0, 80),
            err,
          });
          controller.enqueue(encoder.encode(sse("error", { message: UPSTREAM_ERROR })));
        }
      } finally {
        if (cancelled) await gen.return(undefined as never);
        else controller.close();
      }
    },
    async cancel() {
      // Client disconnected: flag the loop; the generator's finally aborts
      // the Anthropic stream (Task 2, lib/answer.ts).
      cancelled = true;
      await gen.return(undefined as never);
    },
  });
```

- [ ] **Step 6: Run the full gate**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green, new tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/constants.ts lib/answer.ts app/api/ask/route.ts tests/answer.test.ts tests/ask-route.test.ts
git commit -m "fix(reliability): abort Claude stream on client disconnect; share question cap"
```

---

### Task 3: HMAC domain separation in lib/session.ts [Mandatory]

**Files:**
- Modify: `lib/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- All exported signatures unchanged (`createSessionToken`, `verifySessionToken`, `passwordMatches`, constants). Behavior change: session HMACs are computed over `"session:" + payload`, password HMACs over `"pw:" + value`. **Existing session cookies become invalid — acceptable pre-launch (spec §7 note).**

- [ ] **Step 1: Write the failing test**

Append to `tests/session.test.ts`:

```typescript
describe("domain separation", () => {
  it("rejects a token whose signature was computed without the session prefix", async () => {
    // Simulate a pre-prefix (Part 2a) token: payload signed as raw string.
    // We can't call the private hmac() directly, so recreate it inline.
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const payload = String(Date.now());
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
    let bin = "";
    for (const byte of sig) bin += String.fromCharCode(byte);
    const legacySig = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifySessionToken(SECRET, `${payload}.${legacySig}`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npm test`
Expected: FAIL — the legacy-style token still verifies (no prefixes yet).

- [ ] **Step 3: Add the prefixes in `lib/session.ts`**

```typescript
// Domain separation (PR #16 review): the same SESSION_SECRET signs both
// session tokens and password comparisons — prefix the message so an HMAC
// from one domain can never be replayed in the other.
const SESSION_DOMAIN = "session:";
const PASSWORD_DOMAIN = "pw:";
```

In `createSessionToken`: `return `${payload}.${await hmac(secret, SESSION_DOMAIN + payload)}`;`
In `verifySessionToken`: `if (!timingSafeEqual(sig, await hmac(secret, SESSION_DOMAIN + payload))) return false;`
In `passwordMatches`: `return timingSafeEqual(await hmac(secret, PASSWORD_DOMAIN + submitted), await hmac(secret, PASSWORD_DOMAIN + actual));`

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS — including all pre-existing session tests (they only use the public API, which round-trips).

- [ ] **Step 5: Commit**

```bash
git add lib/session.ts tests/session.test.ts
git commit -m "fix(security): domain-separate session and password HMACs"
```

---

### Task 4: Migration 0005 — counter ordering + RPC hardening [Mandatory]

**Files:**
- Create: `supabase/migrations/0005_guardrail_hardening.sql`
- Modify: `lib/rate-limit.ts`
- Test: `tests/rate-limit.test.ts`

**Interfaces:**
- Consumes: existing `usage_counters` table (migration 0004).
- Produces: `record_question(visitor_key text, visitor_limit int)` — global counter increments **only when** `visitor_count <= visitor_limit`; otherwise returns the current global count unchanged. `recordQuestion(supabase, key)` keeps its TS signature (limit passed internally). Route code unchanged.

- [ ] **Step 1: Write the failing test**

In `tests/rate-limit.test.ts`, update the existing `recordQuestion` expectation and add one:

```typescript
it("passes the visitor limit to the RPC so the DB can gate the global increment", async () => {
  const rpc = vi.fn().mockResolvedValue({
    data: [{ visitor_count: 3, global_count: 41 }],
    error: null,
  });
  await recordQuestion(fakeClient(rpc), "some-key");
  expect(rpc).toHaveBeenCalledWith("record_question", {
    visitor_key: "some-key",
    visitor_limit: 20,
  });
});
```

(The existing "returns both counts" test's `toHaveBeenCalledWith` must also gain the `visitor_limit: 20` field.)

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: FAIL — RPC called without `visitor_limit`.

- [ ] **Step 3: Write the migration**

`supabase/migrations/0005_guardrail_hardening.sql`:

```sql
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
```

- [ ] **Step 4: Update `lib/rate-limit.ts`**

```typescript
export async function recordQuestion(supabase: SupabaseClient, key: string): Promise<UsageCounts> {
  const { data, error } = await supabase.rpc("record_question", {
    visitor_key: key,
    visitor_limit: VISITOR_DAILY_LIMIT,
  });
  if (error) throw new Error(`record_question failed: ${error.message}`);
  const row = (data as { visitor_count: number; global_count: number }[])[0];
  if (!row) throw new Error("record_question returned no rows");
  return { visitorCount: row.visitor_count, globalCount: row.global_count };
}
```

(The `!row` guard is the PR #16 review nit — fold it in here.)

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Apply to the live project**

Supabase MCP `apply_migration`, project `moybkceeltzwnyiaasys`, name `guardrail_hardening`, SQL above. Expected: success.

- [ ] **Step 7: Verify live behavior**

Supabase MCP `execute_sql` (privileged, read-write probe on a synthetic key):

```sql
select * from record_question('plan-verify-key', 2);
select * from record_question('plan-verify-key', 2);
select * from record_question('plan-verify-key', 2);
```

Expected: rows `(1, g+1)`, `(2, g+2)`, then `(3, g+2)` — third call increments visitor only. Clean up:

```sql
delete from usage_counters where key = 'plan-verify-key';
update usage_counters set count = count - 2
  where day = (now() at time zone 'utc')::date and scope = 'global' and key = 'global';
```

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0005_guardrail_hardening.sql lib/rate-limit.ts tests/rate-limit.test.ts
git commit -m "fix(security): gate global counter on visitor cap; harden RPC grants and search_path"
```

---

### Task 5: proxy.ts rename + page gating [Mandatory]

**Files:**
- Rename: `middleware.ts` → `proxy.ts` (git mv, then edit)
- Rename test: `tests/middleware.test.ts` → `tests/proxy.test.ts`

**Interfaces:**
- Consumes: `verifySessionToken`, `SESSION_COOKIE` from `lib/session.ts` (unchanged).
- Produces: exported `proxy(req: NextRequest)` — `/api/ask` without session → 401 JSON (unchanged behavior); `/` without session → 302 redirect to `/gate`. Task 8's gate page and Task 9's ask page rely on this gating.

- [ ] **Step 1: Rename and write failing tests**

```bash
git mv middleware.ts proxy.ts
git mv tests/middleware.test.ts tests/proxy.test.ts
```

Replace `tests/proxy.test.ts` content:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { createSessionToken, SESSION_COOKIE } from "../lib/session";

const SECRET = "test-secret-at-least-32-chars-long!!";

const request = (path: string, cookie?: string) => {
  const req = new NextRequest(`http://localhost${path}`, {
    method: path === "/api/ask" ? "POST" : "GET",
  });
  if (cookie) req.cookies.set(SESSION_COOKIE, cookie);
  return proxy(req);
};

describe("proxy", () => {
  beforeEach(() => vi.stubEnv("SESSION_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("passes through /api/ask with a valid session cookie", async () => {
    const res = await request("/api/ask", await createSessionToken(SECRET));
    expect(res.status).toBe(200); // NextResponse.next() reports 200
  });

  it("rejects /api/ask without a session as 401 JSON", async () => {
    const res = await request("/api/ask");
    expect(res.status).toBe(401);
  });

  it("rejects a forged session cookie with 401", async () => {
    const res = await request("/api/ask", "12345.not-a-real-signature");
    expect(res.status).toBe(401);
  });

  it("passes through / with a valid session", async () => {
    const res = await request("/", await createSessionToken(SECRET));
    expect(res.status).toBe(200);
  });

  it("redirects / without a session to /gate", async () => {
    const res = await request("/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/gate");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: FAIL — module exports `middleware`, not `proxy`; no redirect branch.

- [ ] **Step 3: Rewrite `proxy.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// Next.js 16 proxy convention (formerly middleware.ts). Gates the paid API
// route (401 JSON) and the ask page (redirect to the gate screen).
export const config = { matcher: ["/", "/api/ask"] };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const ok = await verifySessionToken(
    requireEnv("SESSION_SECRET"),
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (ok) return NextResponse.next();
  if (req.nextUrl.pathname === "/api/ask") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/gate", req.url));
}
```

- [ ] **Step 4: Run the full gate**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green, and the build **no longer prints the middleware deprecation warning** — confirm its absence explicitly.

- [ ] **Step 5: Commit**

```bash
git add proxy.ts tests/proxy.test.ts
git commit -m "refactor(auth): adopt Next 16 proxy convention; gate ask page with redirect"
```

---

### Task 6: lib/sse-client.ts — incremental SSE parser [Standard]

**Files:**
- Create: `lib/sse-client.ts`
- Test: `tests/sse-client.test.ts`

**Interfaces:**
- Produces: `createSseParser(): (chunk: string) => SseEvent[]` with `interface SseEvent { event: string; data: unknown }`. Stateful closure: feed decoded text chunks in any split; complete `event:`/`data:` blocks (terminated by `\n\n`) come out parsed, partials are buffered. Task 9's `useAskStream` consumes this.

- [ ] **Step 1: Write the failing tests**

`tests/sse-client.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createSseParser } from "../lib/sse-client";

describe("createSseParser", () => {
  it("parses a complete event block", () => {
    const feed = createSseParser();
    expect(feed('event: text\ndata: {"delta":"Hi"}\n\n')).toEqual([
      { event: "text", data: { delta: "Hi" } },
    ]);
  });

  it("buffers partial chunks split mid-line and mid-block", () => {
    const feed = createSseParser();
    expect(feed("event: te")).toEqual([]);
    expect(feed('xt\ndata: {"del')).toEqual([]);
    expect(feed('ta":"Hi"}\n\n')).toEqual([{ event: "text", data: { delta: "Hi" } }]);
  });

  it("returns multiple events from one chunk in order", () => {
    const feed = createSseParser();
    const chunk =
      'event: text\ndata: {"delta":"a"}\n\nevent: done\ndata: {"stopReason":"end_turn"}\n\n';
    expect(feed(chunk).map((e) => e.event)).toEqual(["text", "done"]);
  });

  it("ignores blocks without data", () => {
    const feed = createSseParser();
    expect(feed("event: ping\n\n")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/sse-client.ts`**

```typescript
// Minimal incremental SSE parser for the /api/ask stream. EventSource can't
// POST, so the client reads the fetch body and feeds decoded chunks here.
// Pure and stateful-by-closure: unit-testable without any network.
export interface SseEvent {
  event: string;
  data: unknown;
}

export function createSseParser(): (chunk: string) => SseEvent[] {
  let buffer = "";
  return (chunk: string): SseEvent[] => {
    buffer += chunk;
    const events: SseEvent[] = [];
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) events.push({ event, data: JSON.parse(data) });
    }
    return events;
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sse-client.ts tests/sse-client.test.ts
git commit -m "feat(ui): incremental SSE parser for the ask stream"
```

---

### Task 7: lib/ask-stream.ts — ask state machine [Standard]

**Files:**
- Create: `lib/ask-stream.ts`
- Test: `tests/ask-stream.test.ts`

**Interfaces:**
- Consumes: nothing project-internal (pure types + reducer).
- Produces (Task 9 renders exactly these):

```typescript
export type AskPhase =
  | "idle" | "submitting" | "streaming"
  | "completed" | "refused" | "failed" | "failed_partial"
  | "gated" | "limited";

export interface GlassChunk {
  id: number; law_number: number; breadcrumb: string;
  content: string; similarity: number; rrf_score: number;
}

// The ruling is a segment list, not a plain string: citation markers land
// exactly where they arrived in the stream, and each marker knows its
// passage number ([1], [2], … assigned per distinct document, first-cited-first).
export type RulingSegment =
  | { type: "text"; text: string }
  | { type: "marker"; passageNumber: number; documentIndex: number };

export interface CitedPassage {
  passageNumber: number; documentIndex: number;
  breadcrumb: string; citedText: string;
}

export interface AskState {
  phase: AskPhase;
  question: string;
  segments: RulingSegment[];
  passages: CitedPassage[];       // ordered by passageNumber
  chunks: GlassChunk[];           // all retrieved (meta or gated payload)
  maxSimilarity: number | null;   // only present on gated responses
  citedDocumentIndexes: number[]; // filled on done
  remaining: number | null;       // visitor questions left today
  message: string | null;         // gate / limit / error copy from the API
  limitScope: "visitor" | "global" | null;
}

export type AskAction =
  | { type: "submit"; question: string }
  | { type: "meta"; chunks: GlassChunk[]; remaining: { visitor: number } }
  | { type: "text"; delta: string }
  | { type: "citation"; documentIndex: number; citedText: string }
  | { type: "done"; citedDocumentIndexes: number[] }
  | { type: "refusal" }
  | { type: "stream_error"; message: string }
  | { type: "gated"; message: string; chunks: GlassChunk[]; maxSimilarity: number; remaining: { visitor: number } }
  | { type: "rate_limited"; scope: "visitor" | "global"; message: string }
  | { type: "request_failed"; message: string }
  | { type: "reset" };

export const initialAskState: AskState;
export function askReducer(state: AskState, action: AskAction): AskState;
```

- [ ] **Step 1: Write the failing tests**

`tests/ask-stream.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { askReducer, initialAskState, type AskState, type GlassChunk } from "../lib/ask-stream";

const chunk = (id: number, breadcrumb: string): GlassChunk => ({
  id, law_number: 15, breadcrumb, content: `content of ${breadcrumb}`,
  similarity: 0.8, rrf_score: 0.03,
});

const run = (actions: Parameters<typeof askReducer>[1][]): AskState =>
  actions.reduce(askReducer, initialAskState);

describe("askReducer", () => {
  it("moves idle → submitting → streaming on submit + meta", () => {
    const s = run([
      { type: "submit", question: "throw-in goal?" },
      { type: "meta", chunks: [chunk(1, "Law 15 › 1")], remaining: { visitor: 19 } },
    ]);
    expect(s.phase).toBe("streaming");
    expect(s.remaining).toBe(19);
    expect(s.chunks).toHaveLength(1);
  });

  it("interleaves text and markers as segments with per-document passage numbers", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [chunk(1, "Law 15 › 1"), chunk(2, "Law 15 › 3")], remaining: { visitor: 19 } },
      { type: "text", delta: "No " },
      { type: "citation", documentIndex: 1, citedText: "second doc first" },
      { type: "text", delta: "— goal kick " },
      { type: "citation", documentIndex: 0, citedText: "first doc second" },
      { type: "citation", documentIndex: 1, citedText: "repeat doc" },
    ]);
    expect(s.segments).toEqual([
      { type: "text", text: "No " },
      { type: "marker", passageNumber: 1, documentIndex: 1 },
      { type: "text", text: "— goal kick " },
      { type: "marker", passageNumber: 2, documentIndex: 0 },
      { type: "marker", passageNumber: 1, documentIndex: 1 },
    ]);
    // passages: first-cited document gets [1]; repeat citation of the same
    // document appends its citedText to the existing passage, not a new one
    expect(s.passages.map((p) => p.passageNumber)).toEqual([1, 2]);
    expect(s.passages[0].breadcrumb).toBe("Law 15 › 3");
  });

  it("completes on done, keeping remaining and cited indexes", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [chunk(1, "Law 15 › 1")], remaining: { visitor: 19 } },
      { type: "text", delta: "answer" },
      { type: "done", citedDocumentIndexes: [0] },
    ]);
    expect(s.phase).toBe("completed");
    expect(s.citedDocumentIndexes).toEqual([0]);
  });

  it("keeps partial text on stream_error (failed_partial)", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [], remaining: { visitor: 19 } },
      { type: "text", delta: "partial " },
      { type: "stream_error", message: "something went wrong, please try again shortly" },
    ]);
    expect(s.phase).toBe("failed_partial");
    expect(s.segments).toEqual([{ type: "text", text: "partial " }]);
    expect(s.message).toContain("try again");
  });

  it("handles gated responses with chunks and maxSimilarity", () => {
    const s = run([
      { type: "submit", question: "lbw?" },
      { type: "gated", message: "I can only answer questions about the Laws of the Game.",
        chunks: [chunk(1, "Law 11 › 1")], maxSimilarity: 0.31, remaining: { visitor: 18 } },
    ]);
    expect(s.phase).toBe("gated");
    expect(s.maxSimilarity).toBe(0.31);
    expect(s.remaining).toBe(18);
  });

  it("records limit scope on rate_limited", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "rate_limited", scope: "global", message: "The demo's daily budget is used up — please come back tomorrow." },
    ]);
    expect(s.phase).toBe("limited");
    expect(s.limitScope).toBe("global");
  });

  it("refusal ends refused with no partial-answer debris", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [], remaining: { visitor: 19 } },
      { type: "text", delta: "should be discarded" },
      { type: "refusal" },
    ]);
    expect(s.phase).toBe("refused");
    expect(s.segments).toEqual([]);
  });

  it("reset returns to initial state but keeps remaining", () => {
    const s = run([
      { type: "submit", question: "q" },
      { type: "meta", chunks: [], remaining: { visitor: 19 } },
      { type: "done", citedDocumentIndexes: [] },
      { type: "reset" },
    ]);
    expect(s.phase).toBe("idle");
    expect(s.remaining).toBe(19);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/ask-stream.ts`**

```typescript
// Pure state machine for one ask cycle (spec §5). The hook feeds it API
// events; components render AskState. No React, no network — fully
// unit-testable.

/* [Interfaces exactly as the block above — copy the full type definitions
   from this task's Interfaces section verbatim.] */

export const initialAskState: AskState = {
  phase: "idle", question: "", segments: [], passages: [], chunks: [],
  maxSimilarity: null, citedDocumentIndexes: [], remaining: null,
  message: null, limitScope: null,
};

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case "submit":
      return { ...initialAskState, remaining: state.remaining, phase: "submitting", question: action.question };
    case "meta":
      return { ...state, phase: "streaming", chunks: action.chunks, remaining: action.remaining.visitor };
    case "text": {
      const segments = [...state.segments];
      const last = segments[segments.length - 1];
      if (last?.type === "text") {
        segments[segments.length - 1] = { type: "text", text: last.text + action.delta };
      } else {
        segments.push({ type: "text", text: action.delta });
      }
      return { ...state, segments };
    }
    case "citation": {
      const existing = state.passages.find((p) => p.documentIndex === action.documentIndex);
      const passageNumber = existing?.passageNumber ?? state.passages.length + 1;
      const passages = existing
        ? state.passages.map((p) =>
            p.documentIndex === action.documentIndex
              ? { ...p, citedText: `${p.citedText}\n${action.citedText}` }
              : p,
          )
        : [
            ...state.passages,
            {
              passageNumber,
              documentIndex: action.documentIndex,
              breadcrumb: state.chunks[action.documentIndex]?.breadcrumb ?? "",
              citedText: action.citedText,
            },
          ];
      return {
        ...state,
        passages,
        segments: [...state.segments, { type: "marker", passageNumber, documentIndex: action.documentIndex }],
      };
    }
    case "done":
      return { ...state, phase: "completed", citedDocumentIndexes: action.citedDocumentIndexes };
    case "refusal":
      return { ...state, phase: "refused", segments: [], passages: [] };
    case "stream_error":
      return { ...state, phase: "failed_partial", message: action.message };
    case "gated":
      return {
        ...state, phase: "gated", message: action.message, chunks: action.chunks,
        maxSimilarity: action.maxSimilarity, remaining: action.remaining.visitor,
      };
    case "rate_limited":
      return { ...state, phase: "limited", limitScope: action.scope, message: action.message };
    case "request_failed":
      return { ...state, phase: "failed", message: action.message };
    case "reset":
      return { ...initialAskState, remaining: state.remaining };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ask-stream.ts tests/ask-stream.test.ts
git commit -m "feat(ui): ask-cycle state machine with segment-based citation markers"
```

---

### Task 8: Gate screen [Standard — invoke `frontend-design` first]

**Files:**
- Create: `app/gate/page.tsx`
- Create: `components/GateForm.tsx`

**Interfaces:**
- Consumes: `POST /api/session` (204 sets cookies; 401 wrong password; 400 malformed).
- Produces: the `/gate` route Task 5's proxy redirects to.

**REQUIRED FIRST STEP: invoke the `frontend-design` skill** (Skill tool) before writing any component code, then apply its guidance within the token system from Task 1 (no raw hex — Global Constraints).

- [ ] **Step 1: Invoke `frontend-design`, then create `app/gate/page.tsx`**

```tsx
import { GateForm } from "@/components/GateForm";

export default function GatePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
      <header className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">The Fourth Official</h1>
        <p className="mt-1 text-sm opacity-70">Rulings from the Laws of the Game</p>
      </header>
      <GateForm />
    </main>
  );
}
```

- [ ] **Step 2: Create `components/GateForm.tsx`**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CardBadge } from "@/components/CardBadge";

export function GateForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 204) {
        router.push("/");
        return;
      }
      setError(res.status === 401 ? "wrong password" : "something went wrong, please try again shortly");
    } catch {
      setError("something went wrong, please try again shortly");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3">
      <p className="text-sm opacity-70">This is a private demo.</p>
      <label htmlFor="password" className="text-sm font-medium">
        Password
      </label>
      <div className="flex gap-2">
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          required
          className="min-h-11 flex-1 rounded-md border border-foreground/20 bg-transparent px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="min-h-11 rounded-md bg-accent px-6 font-semibold text-accent-contrast disabled:opacity-50"
        >
          Enter
        </button>
      </div>
      {error && <CardBadge kind="red" message={error} />}
    </form>
  );
}
```

`CardBadge` is shared with Task 9 but created HERE (task implementers see only their own task). Create `components/CardBadge.tsx`:

```tsx
export function CardBadge({ kind, message }: { kind: "yellow" | "red"; message: string }) {
  return (
    <p className="flex items-center gap-2 text-sm" role="alert">
      <span
        aria-hidden
        className={`inline-block h-4 w-3 shrink-0 -rotate-6 rounded-[3px] ${
          kind === "yellow" ? "bg-card-yellow" : "bg-card-red"
        }`}
      />
      <span className={kind === "red" ? "text-error" : ""}>{message}</span>
    </p>
  );
}
```

- [ ] **Step 3: Verify manually**

Run: `npm run dev`, open `http://localhost:3000/gate` (and `http://localhost:3000/` — should redirect here without a session).
Expected: gate renders in light + dark; wrong password shows the red-card message below the field with focus retained; right password lands on `/` (scaffold page until Task 9).

- [ ] **Step 4: Full gate + commit**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`

```bash
git add app/gate/page.tsx components/GateForm.tsx components/CardBadge.tsx
git commit -m "feat(ui): gate screen with password form and card-badge errors"
```

---

### Task 9: Ask screen — components + hook [Standard — invoke `frontend-design` first]

**Files:**
- Replace: `app/page.tsx` (scaffold → ask screen)
- Create: `components/AskForm.tsx`, `components/RulingCard.tsx`, `components/LawPassages.tsx`, `components/GlassBox.tsx`, `components/HistoryList.tsx`, `components/RemainingBadge.tsx`, `lib/glass-constants.ts` (`components/CardBadge.tsx` already exists from Task 8 — do not recreate)
- Create: `hooks/useAskStream.ts`

**Interfaces:**
- Consumes: `askReducer`/`initialAskState`/types (Task 7), `createSseParser` (Task 6), `MAX_QUESTION_CHARS` (Task 2), tokens (Task 1).
- Produces: the complete `/` ask experience per mockup Option A.

**REQUIRED FIRST STEP: invoke the `frontend-design` skill** before writing component code. Layout reference: mockup file Option A (✅ CHOSEN). Decisions in force: Q2 collapsed history (page state only), Q3 click-to-scroll with ~1s accent flash, Q4 glass box open on first answer then remember toggle.

- [ ] **Step 1: Create `hooks/useAskStream.ts`**

```tsx
"use client";

import { useCallback, useReducer, useRef } from "react";
import { askReducer, initialAskState, type AskAction, type AskState } from "@/lib/ask-stream";
import { createSseParser } from "@/lib/sse-client";

const NETWORK_ERROR = "something went wrong, please try again shortly";

export function useAskStream(): { state: AskState; ask: (question: string) => Promise<void> } {
  const [state, dispatch] = useReducer(askReducer, initialAskState);
  const abortRef = useRef<AbortController | null>(null);

  const ask = useCallback(async (question: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "submit", question });

    let res: Response;
    try {
      res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) dispatch({ type: "request_failed", message: NETWORK_ERROR });
      return;
    }

    if (res.status === 401) {
      window.location.href = "/gate";
      return;
    }

    if (res.headers.get("content-type")?.includes("application/json")) {
      const body = await res.json();
      if (body.kind === "gated") {
        dispatch({ type: "gated", message: body.message, chunks: body.chunks,
          maxSimilarity: body.maxSimilarity, remaining: body.remaining });
      } else if (body.kind === "rate_limited") {
        dispatch({ type: "rate_limited", scope: body.scope, message: body.message });
      } else {
        dispatch({ type: "request_failed", message: body.error ?? NETWORK_ERROR });
      }
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const feed = createSseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of feed(decoder.decode(value, { stream: true }))) {
          dispatch(sseToAction(ev.event, ev.data));
        }
      }
    } catch {
      if (!controller.signal.aborted) dispatch({ type: "stream_error", message: NETWORK_ERROR });
    }
  }, []);

  return { state, ask };
}

function sseToAction(event: string, data: unknown): AskAction {
  const d = data as Record<string, never>;
  switch (event) {
    case "meta": return { type: "meta", chunks: d["chunks"], remaining: d["remaining"] };
    case "text": return { type: "text", delta: d["delta"] };
    case "citation": return { type: "citation", documentIndex: d["documentIndex"], citedText: d["citedText"] };
    case "done": return { type: "done", citedDocumentIndexes: d["citedDocumentIndexes"] };
    case "refusal": return { type: "refusal" };
    case "error": return { type: "stream_error", message: d["message"] };
    default: return { type: "stream_error", message: `unknown event: ${event}` };
  }
}
```

- [ ] **Step 2: Create the presentational components**

(`CardBadge` exists from Task 8; its interface is `CardBadge({ kind: "yellow" | "red", message: string })`.)

`components/RemainingBadge.tsx`:

```tsx
export function RemainingBadge({ remaining }: { remaining: number | null }) {
  if (remaining === null) return null;
  return (
    <span className="font-mono text-xs opacity-70" aria-label={`${remaining} of 20 questions left today`}>
      {remaining}/20 today
    </span>
  );
}
```

`components/AskForm.tsx`:

```tsx
"use client";

import { useState } from "react";
import { MAX_QUESTION_CHARS } from "@/lib/constants";

export function AskForm({ busy, disabled, onAsk }: {
  busy: boolean; disabled: boolean; onAsk: (question: string) => void;
}) {
  const [question, setQuestion] = useState("");
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (question.trim()) onAsk(question); }}
      className="flex flex-col gap-1"
    >
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={MAX_QUESTION_CHARS}
          placeholder="Ask about the Laws of the Game"
          aria-label="Your question"
          disabled={disabled}
          className="min-h-11 flex-1 rounded-md border border-foreground/20 bg-transparent px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || disabled || question.trim().length === 0}
          className="min-h-11 rounded-md bg-accent px-6 font-semibold text-accent-contrast disabled:opacity-50"
        >
          {busy ? "…" : "Ask"}
        </button>
      </div>
      <span className="self-end font-mono text-xs opacity-50">
        {question.length}/{MAX_QUESTION_CHARS}
      </span>
    </form>
  );
}
```

`components/RulingCard.tsx` (Q3: markers are buttons; click scrolls + flashes):

```tsx
"use client";

import type { RulingSegment } from "@/lib/ask-stream";

export function flashPassage(passageNumber: number) {
  const el = document.getElementById(`passage-${passageNumber}`);
  if (!el) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  el.classList.add("bg-accent/15");
  setTimeout(() => el.classList.remove("bg-accent/15"), 1000);
}

export function RulingCard({ segments, streaming }: { segments: RulingSegment[]; streaming: boolean }) {
  if (segments.length === 0 && !streaming) return null;
  return (
    <section aria-live="polite">
      <h2 className="text-xs font-semibold uppercase tracking-widest opacity-60">The ruling</h2>
      <p className="mt-2 border-t border-foreground/15 pt-3 text-base leading-7">
        {segments.map((seg, i) =>
          seg.type === "text" ? (
            <span key={i}>{seg.text}</span>
          ) : (
            <button
              key={i}
              onClick={() => flashPassage(seg.passageNumber)}
              aria-label={`Show cited passage ${seg.passageNumber}`}
              className="mx-0.5 inline-block min-h-6 cursor-pointer px-1 font-mono text-sm font-medium text-accent"
            >
              [{seg.passageNumber}]
            </button>
          ),
        )}
        {streaming && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-foreground align-middle" aria-hidden />}
      </p>
    </section>
  );
}
```

`components/LawPassages.tsx`:

```tsx
import type { CitedPassage } from "@/lib/ask-stream";

export function LawPassages({ passages }: { passages: CitedPassage[] }) {
  if (passages.length === 0) return null;
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-widest opacity-60">What the law says</h2>
      <ul className="mt-2 flex flex-col gap-3 border-t border-foreground/15 pt-3">
        {passages.map((p) => (
          <li key={p.passageNumber} id={`passage-${p.passageNumber}`} className="rounded transition-colors duration-300">
            <span className="font-mono text-sm text-accent">[{p.passageNumber}]</span>{" "}
            <span className="font-mono text-sm">{p.breadcrumb}</span>
            <blockquote className="mt-1 border-l-2 border-foreground/20 pl-3 text-sm italic opacity-90 whitespace-pre-line">
              “{p.citedText}”
            </blockquote>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

`components/GlassBox.tsx` (Q4: `open` controlled by the page):

```tsx
import { RELEVANCE_THRESHOLD } from "@/lib/glass-constants";
import type { GlassChunk } from "@/lib/ask-stream";

export function GlassBox({ chunks, citedDocumentIndexes, maxSimilarity, open, onToggle }: {
  chunks: GlassChunk[]; citedDocumentIndexes: number[];
  maxSimilarity: number | null; open: boolean; onToggle: (open: boolean) => void;
}) {
  if (chunks.length === 0) return null;
  const best = maxSimilarity ?? Math.max(...chunks.map((c) => c.similarity));
  return (
    <details
      open={open}
      onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}
      className="border-t border-foreground/15 pt-3"
    >
      <summary className="min-h-11 cursor-pointer list-none text-sm font-medium">
        <span aria-hidden>{open ? "▾" : "▸"}</span> How this answer was built ·{" "}
        {chunks.length} passages retrieved
      </summary>
      <table className="mt-2 w-full text-left font-mono text-xs">
        <thead>
          <tr className="opacity-60">
            <th className="py-1 pr-2 font-normal">#</th>
            <th className="py-1 pr-2 font-normal">passage</th>
            <th className="py-1 pr-2 font-normal">similarity</th>
            <th className="py-1 font-normal">cited</th>
          </tr>
        </thead>
        <tbody>
          {chunks.map((c, i) => (
            <tr key={c.id} className="border-t border-foreground/10">
              <td className="py-1.5 pr-2">{i + 1}</td>
              <td className="py-1.5 pr-2">{c.breadcrumb}</td>
              <td className="py-1.5 pr-2">{c.similarity.toFixed(3)}</td>
              <td className="py-1.5">{citedDocumentIndexes.includes(i) ? "✓" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 font-mono text-xs opacity-60">
        gate: max similarity {best.toFixed(3)} {best >= RELEVANCE_THRESHOLD ? "≥" : "<"} threshold {RELEVANCE_THRESHOLD}
      </p>
    </details>
  );
}
```

**`lib/glass-constants.ts` (create):** `lib/retrieval.ts` is `server-only` and cannot be imported by client components. Mirror the one value the UI needs, with a comment binding them:

```typescript
// Client-side mirror of RELEVANCE_THRESHOLD in lib/retrieval.ts (server-only
// module — not importable from client components). Keep in sync; the eval
// harness calibrates the server value (see retrieval.ts's comment).
export const RELEVANCE_THRESHOLD = 0.35;
```

`components/HistoryList.tsx` (Q2: page state only):

```tsx
"use client";

import { useState } from "react";
import type { AskState } from "@/lib/ask-stream";
import { RulingCard } from "@/components/RulingCard";
import { LawPassages } from "@/components/LawPassages";

export interface HistoryEntry {
  question: string;
  state: AskState;
}

export function HistoryList({ entries }: { entries: HistoryEntry[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (entries.length === 0) return null;
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-widest opacity-60">Earlier this visit</h2>
      <ul className="mt-2 flex flex-col gap-1 border-t border-foreground/15 pt-3">
        {entries.map((entry, i) => (
          <li key={i}>
            <button
              onClick={() => setOpenIndex(openIndex === i ? null : i)}
              className="min-h-11 w-full cursor-pointer text-left text-sm opacity-80 hover:opacity-100"
            >
              <span aria-hidden>{openIndex === i ? "▾" : "▸"}</span> {entry.question}
            </button>
            {openIndex === i && (
              <div className="mb-3 flex flex-col gap-4 pl-4">
                <RulingCard segments={entry.state.segments} streaming={false} />
                <LawPassages passages={entry.state.passages} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: Replace `app/page.tsx`**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { AskForm } from "@/components/AskForm";
import { CardBadge } from "@/components/CardBadge";
import { GlassBox } from "@/components/GlassBox";
import { HistoryList, type HistoryEntry } from "@/components/HistoryList";
import { LawPassages } from "@/components/LawPassages";
import { RemainingBadge } from "@/components/RemainingBadge";
import { RulingCard } from "@/components/RulingCard";
import { useAskStream } from "@/hooks/useAskStream";

const TERMINAL = ["completed", "refused", "failed", "failed_partial", "gated"] as const;

export default function AskPage() {
  const { state, ask } = useAskStream();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // Q4: glass box opens on the first answer of the visit; after the user
  // touches the toggle, their preference wins for the rest of the visit.
  const [glassOpen, setGlassOpen] = useState(true);
  const userToggled = useRef(false);
  const lastArchived = useRef<string | null>(null);

  const busy = state.phase === "submitting" || state.phase === "streaming";
  const isTerminal = (TERMINAL as readonly string[]).includes(state.phase);

  // Q2: archive each finished Q&A into the visit history exactly once.
  useEffect(() => {
    if (!isTerminal) return;
    if (state.segments.length + state.chunks.length === 0) return;
    if (lastArchived.current === state.question) return;
    lastArchived.current = state.question;
    setHistory((h) => [{ question: state.question, state }, ...h]);
  }, [isTerminal, state]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">The Fourth Official</h1>
          <p className="font-mono text-xs opacity-60">Laws of the Game 2025/26</p>
        </div>
        <RemainingBadge remaining={state.remaining} />
      </header>

      <AskForm busy={busy} disabled={state.phase === "limited" && state.limitScope === "global"} onAsk={ask} />

      {state.phase === "limited" && <CardBadge kind="yellow" message={state.message ?? ""} />}
      {state.phase === "failed" && <CardBadge kind="red" message={state.message ?? ""} />}
      {state.phase === "refused" && (
        <CardBadge kind="red" message="The Fourth Official declined to answer that one." />
      )}
      {state.phase === "gated" && <p className="text-sm">{state.message}</p>}

      <RulingCard segments={state.segments} streaming={state.phase === "streaming"} />
      {state.phase === "failed_partial" && (
        <CardBadge kind="red" message={`answer incomplete — ${state.message ?? ""}`} />
      )}
      <LawPassages passages={state.passages} />
      <GlassBox
        chunks={state.chunks}
        citedDocumentIndexes={state.citedDocumentIndexes}
        maxSimilarity={state.maxSimilarity}
        open={glassOpen}
        onToggle={(open) => { userToggled.current = true; setGlassOpen(open); }}
      />

      <HistoryList entries={history} />
    </main>
  );
}
```

- [ ] **Step 4: Full gate**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 5: Manual smoke (dev, `.env.local`)**

`npm run dev` and walk: login → real question (stream, markers clickable, flash works, glass box open first time, collapse persists) → second question (history entry appears; glass box stays collapsed if collapsed) → off-topic question (gated copy + glass box shows sub-threshold maxSim) → check 375px width, dark mode, reduced-motion (DevTools emulation: scroll jumps instead of smoothing).

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx components/ hooks/ lib/glass-constants.ts
git commit -m "feat(ui): ask screen — streamed ruling, citations, glass box, visit history"
```

---

### Task 10: Railway deploy + trusted-XFF fix [Mandatory]

**Files:**
- Modify: `lib/rate-limit.ts` (add `trustedClientIp`)
- Modify: `app/api/ask/route.ts:168` (use it)
- Test: `tests/rate-limit.test.ts`

**Markus inputs required:** Railway account confirmation, production values for all env vars, and a **fresh 32+-char random `DEMO_PASSWORD`** (generate: `openssl rand -base64 32` in Git Bash) — the documented mitigation for the accepted login-rate-limit gap. Do not reuse the dev password.

- [ ] **Step 1: Create the Railway service**

Railway MCP: `create_project` (name `the-fourth-official`) → `create_service` from GitHub repo `markusluisflores/the-fourth-official`, branch `main`… **but deploy from the feature branch for the probe**: connect source to `feat/ui-deploy` initially (switch to `main` after the PR merges — Step 7).

- [ ] **Step 2: Set env vars** (`set_variables`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL=claude-haiku-4-5`, `DEMO_PASSWORD` (new strong value), `SESSION_SECRET` (fresh `openssl rand -base64 32`; dev sessions don't carry over anyway after Task 3).

- [ ] **Step 3: `generate_domain`, deploy, verify basics**

Expected: HTTPS URL serves the gate; login works; one real question streams end-to-end in production.

- [ ] **Step 4: Probe the XFF chain (answers the open IP-trust question)**

From a local shell, send a spoofed header to the deployed app:

```bash
curl -s -X POST "https://<railway-domain>/api/session" \
  -H "content-type: application/json" \
  -H "x-forwarded-for: 203.0.113.99" \
  -d '{"password":"wrong-on-purpose"}'
```

Then Railway MCP `get_logs` after temporarily adding this log line at the top of the session route's POST (commit, push, let it deploy, then revert the commit after the probe):

```typescript
console.log("xff-probe", { xff: req.headers.get("x-forwarded-for") });
```

Read the logged value. Expected shape: `"203.0.113.99, <real-client-ip>"` — i.e. Railway's edge **appends** the real client IP as the rightmost entry. **If the log shows anything else (single value, different order, or a Railway-specific header like `x-real-ip` present instead), STOP — report the exact logged value as BLOCKED and wait for a decision. Do not guess a parsing strategy.**

- [ ] **Step 5: Write the failing tests for `trustedClientIp`**

Append to `tests/rate-limit.test.ts`:

```typescript
import { trustedClientIp } from "../lib/rate-limit";

describe("trustedClientIp", () => {
  it("takes the rightmost entry — the hop our platform's edge appended", () => {
    expect(trustedClientIp("203.0.113.99, 198.51.100.7")).toBe("198.51.100.7");
    expect(trustedClientIp("a, b, c")).toBe("c");
  });

  it("handles a single entry and whitespace", () => {
    expect(trustedClientIp(" 198.51.100.7 ")).toBe("198.51.100.7");
  });

  it("falls back for missing or empty headers", () => {
    expect(trustedClientIp(null)).toBe("local");
    expect(trustedClientIp("")).toBe("local");
  });
});
```

- [ ] **Step 6: Implement and rewire**

In `lib/rate-limit.ts`:

```typescript
// Which x-forwarded-for hop to trust is platform-specific. Verified live on
// Railway (Part 2b Task 10 probe, 2026-07): the edge APPENDS the real client
// IP, so the rightmost entry is the only one the client cannot control.
// Leftmost entries are client-supplied and spoofable (PR #16 finding).
export function trustedClientIp(header: string | null): string {
  const last = header?.split(",").at(-1)?.trim();
  return last || "local";
}
```

In `app/api/ask/route.ts`, replace the `const ip = …` line (and delete its now-stale gap comment block about XFF, keeping the counter-ordering history note only if migration 0005 context is referenced elsewhere — the comment should now read):

```typescript
  // Rate-limit key: platform-verified client IP (see trustedClientIp) plus
  // the visitor cookie. The two remaining Part 2a gap notes (leftmost-XFF
  // trust, global-counter ordering) are both resolved: Task 10 probe + 
  // migration 0005.
  const ip = trustedClientIp(req.headers.get("x-forwarded-for"));
```

(add `trustedClientIp` to the existing `@/lib/rate-limit` import)

- [ ] **Step 7: Full gate, redeploy, verify the fix live**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`; push; after deploy, repeat the Step 4 curl twice with two different spoofed leftmost IPs and the same real origin + visitor cookie, then check Supabase (`execute_sql`): both requests must land on the **same** `usage_counters` visitor row.

- [ ] **Step 8: Commit**

```bash
git add lib/rate-limit.ts app/api/ask/route.ts tests/rate-limit.test.ts
git commit -m "fix(security): key rate limits on the platform-verified client IP"
```

---

### Task 11: Docs, wrap-up, PR [Routine + process]

**Files:**
- Replace: `README.md` (scaffold boilerplate → real readme)
- Modify: `CLAUDE.md` (accuracy fixes + Part 2b state)
- Delete: `NEXT-SESSION.md`

- [ ] **Step 1: Replace `README.md`**

```markdown
# The Fourth Official

Football rules Q&A grounded in the IFAB **Laws of the Game** — ask a question in
plain English, get a referee-neutral ruling that cites the exact law passages it
rests on, streamed live, with a "How this answer was built" panel showing every
retrieved passage, its similarity score, and whether the answer actually used it.

Built as a portfolio RAG project: hybrid retrieval (pgvector + Postgres full-text,
fused with RRF) over the official rulebook, Claude with native citations for
generation, and measured evals (recall@8, MRR, gate calibration) behind every
tuning decision.

## Stack

Next.js (App Router) · Supabase Postgres + pgvector · Voyage `voyage-4-lite`
embeddings · Claude Haiku 4.5 with `citations: {enabled: true}` · Vitest · Railway.

## How it works

1. **Ingestion (offline):** the official PDF is parsed, cleaned, and chunked along
   the rulebook's own structure (law → section), embedded, and upserted into
   Supabase (`npm run ingest`).
2. **Retrieval:** one SQL RPC runs vector + keyword search and merges rankings
   with Reciprocal Rank Fusion; a calibrated relevance gate abstains on off-topic
   questions before any generation spend.
3. **Generation:** retrieved chunks go to Claude as document blocks with native
   citations — the answer streams back with structured claim-to-passage links,
   not prompt-glued markers.
4. **Guardrails:** shared-password gate, per-visitor and global daily budgets
   (atomic Postgres counters), 300-char input cap, deny-all RLS with server-only
   data access (ADR-001).

## Development

`npm run dev` — needs `.env.local` (see `.env.local.example`). Tests: `npm test`.
Retrieval evals: `npm run eval`. Full docs: `docs/` (design specs, plans, ADRs,
session journal, interview guide).
```

- [ ] **Step 2: Fix `CLAUDE.md`**

Apply exactly these corrections (all from the PR #16 review / handoff):
- File layout: `lib/ — voyage.ts, retrieval.ts, answer.ts, auth.ts` → `lib/ — voyage.ts, retrieval.ts, answer.ts, session.ts, rate-limit.ts, supabase.ts, constants.ts, sse-client.ts, ask-stream.ts, glass-constants.ts`; add `components/ + hooks/ — ask & gate UI (Part 2b)`; `middleware.ts` line → `proxy.ts  session gating: 401 for /api/ask, redirect to /gate for pages`.
- Migration `0003` description: "RLS policies (deny all, server role excepted)" → "enable RLS on chunks (deny-all: zero policies; service role bypasses)".
- Migration `0004` description: "counter table + trigger" → "usage_counters table + record_question RPC"; add `0005_guardrail_hardening.sql  counter ordering + RPC grants/search_path`.
- Project phases: mark Part 2a complete-and-merged, add "Part 2b (complete): UI + Railway deploy".
- Secrets section: note `DEMO_PASSWORD` must be 32+ random chars in production (deploy prerequisite).

- [ ] **Step 3: Delete the consumed handoff**

```bash
git rm NEXT-SESSION.md
```

(Its every item is now either shipped in this plan, recorded in memory (`part2b-deploy-blockers`), or explicitly parked — prompt-injection spec session and issue-spam triage remain in `vector-proj-goals` memory.)

- [ ] **Step 4: Full gate + commit**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`

```bash
git add README.md CLAUDE.md
git commit -m "docs: real README, CLAUDE.md accuracy fixes, retire Part 2a handoff"
```

- [ ] **Step 5: Eval regression check**

Run: `npm run eval` (~16 min on the Voyage free tier).
Expected: golden 30/30, MRR ≥ 0.859; paraphrase 10/10. Any drop = STOP, investigate before the PR (nothing in this plan should touch retrieval behavior — migration 0005 changed grants/search_path only).

- [ ] **Step 6: Mandatory-tier review battery + PR**

1. Dispatch the `security-reviewer` agent over the full branch diff (focus: Tasks 3, 4, 5, 10).
2. Run `/security-review`.
3. Invoke `pre-pr-review` skill (checklist, impact check, Definition of Done), then `superpowers:verification-before-completion`, then `commit-commands:commit-push-pr`.

PR body must include: what shipped (screens, deploy, hardening), the XFF probe evidence (logged value verbatim), migration 0005 verification output, eval numbers, and the manual smoke list results (dev + production).

---

## Execution notes for the controller session

- Dispatch per-task with `superpowers:subagent-driven-development`; the implementer template now REQUIRES the cwd/branch verification first command — include worktree path AND `feat/ui-deploy` in every dispatch.
- Tasks 8 and 9 dispatches must instruct the implementer to invoke the `frontend-design` skill as their literal second action (after cwd verification).
- Task 10 has two hard STOP gates (probe result mismatch; Markus env inputs). Do not improvise past them.
- After merge: interview-prep capture pass (Part 2a rulings + Part 2b) is queued in memory `vector-proj-goals`.
