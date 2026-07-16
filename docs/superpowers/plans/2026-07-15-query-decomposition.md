# Query Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compound questions retrieve all the law sections a complete answer needs, by splitting them into sub-questions with a parallel Haiku call, retrieving per sub-question, and merging — with the same retrieval results and fallback behavior for simple questions, and latency bounded (not unconditionally unchanged — revised 2026-07-15, see Task 3) rather than exposed to decompose's full budget.

**Architecture:** The `/api/ask` route fires the decompose call and today's baseline retrieval concurrently. The route awaits baseline first (as it always did), then gives decompose only whatever remains of a soft deadline (`DECOMPOSE_SOFT_DEADLINE_MS`) measured from when both calls started — an elapsed-aware race, not a fixed wall-clock cutoff (revised 2026-07-15 per a task-review finding + Fable's design review, PR #49; see Task 3's note). A "simple" verdict (or any decomposer failure, or a miss past the soft deadline) uses the baseline result unchanged; a 2–4-way split embeds all sub-questions in one Voyage call, searches per sub-question in parallel, and merges by rank round-robin (dedupe by chunk id, cap 12). The gate and answer stages are untouched; the answering model sees only the original question. Spec: `docs/superpowers/specs/2026-07-15-query-decomposition-design.md`.

**Tech Stack:** Next.js App Router (TypeScript strict) · `@anthropic-ai/sdk` (structured outputs, `claude-haiku-4-5`) · Voyage `voyage-4-lite` embeddings · Supabase `match_chunks` RPC · Vitest.

## Global Constraints

- All new logic lives under `lib/` (never `app/`) per the Part 1 plan's Global Constraints; tests mirror in `tests/`.
- Branch: `feat/query-decomposition` off `main`. Never push to `main`; no merging your own PR.
- Before ANY commit: `pwd` and `git branch --show-current` must show the project dir and `feat/query-decomposition`.
- Commit messages follow `C:\Users\Miko\.claude\standards\git-commit-standard.md` (conventional commits, header ≤72 chars — commitlint enforces this in the commit-msg hook).
- Secrets never in code or commits. `ANTHROPIC_API_KEY` is read from the environment only (`.env.local` locally; already present).
- The visitor's question and the parsed sub-questions are DATA: they go in user messages / embed inputs / `match_chunks` `query_text` only — never concatenated into any system prompt (spec §8).
- Production retrieval constants are frozen: per-query k=8, `RELEVANCE_THRESHOLD = 0.35`, `match_chunks` unchanged.
- Tier: Standard (two-stage review per task + `reviewer` agent). Task 1 additionally gets `/security-review` + the `security-reviewer` agent (new user-input→LLM surface, spec §9).
- Verification commands available: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run eval` (free), `npm run eval -- --decompose` (paid, ~a cent).

---

### Task 1: `lib/decompose.ts` — the decompose call

**Files:**
- Create: `lib/decompose.ts`
- Test: `tests/decompose.test.ts`

**Interfaces:**
- Consumes: nothing new (Anthropic SDK, already a dependency).
- Produces: `decompose(question: string, client?: Anthropic): Promise<string[] | null>` — resolves to 1–4 trimmed non-empty sub-questions, or `null` meaning "use the baseline path". **Never rejects.** Also exports pure `parseSubQuestions(raw: string): string[] | null` and constants `DECOMPOSE_MODEL`, `MAX_SUB_QUESTIONS`, `DECOMPOSE_TIMEOUT_MS`, `DECOMPOSE_SYSTEM_PROMPT`.

- [ ] **Step 1: Write the failing tests**

Create `tests/decompose.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  decompose,
  DECOMPOSE_MODEL,
  DECOMPOSE_TIMEOUT_MS,
  MAX_SUB_QUESTIONS,
  parseSubQuestions,
} from "../lib/decompose";

const fakeClient = (create: ReturnType<typeof vi.fn>) =>
  ({ messages: { create } }) as unknown as Anthropic;

const okResponse = (subs: unknown) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ sub_questions: subs }) }],
});

describe("parseSubQuestions", () => {
  it("returns a valid 2-4 way split", () => {
    expect(parseSubQuestions(JSON.stringify({ sub_questions: ["a?", "b?", "c?"] }))).toEqual([
      "a?",
      "b?",
      "c?",
    ]);
  });

  it("returns a single-question array unchanged", () => {
    expect(parseSubQuestions(JSON.stringify({ sub_questions: ["only?"] }))).toEqual(["only?"]);
  });

  it("trims entries and drops empty/whitespace-only strings", () => {
    expect(parseSubQuestions(JSON.stringify({ sub_questions: ["  a?  ", "", "   "] }))).toEqual([
      "a?",
    ]);
  });

  it("drops non-string entries", () => {
    expect(parseSubQuestions(JSON.stringify({ sub_questions: ["a?", 7, null] }))).toEqual(["a?"]);
  });

  it("caps at MAX_SUB_QUESTIONS by keeping the first ones", () => {
    const six = ["a?", "b?", "c?", "d?", "e?", "f?"];
    expect(parseSubQuestions(JSON.stringify({ sub_questions: six }))).toEqual(
      six.slice(0, MAX_SUB_QUESTIONS),
    );
  });

  it("returns null for non-JSON, wrong shape, and empty list", () => {
    expect(parseSubQuestions("not json")).toBeNull();
    expect(parseSubQuestions(JSON.stringify({ nope: [] }))).toBeNull();
    expect(parseSubQuestions(JSON.stringify({ sub_questions: [] }))).toBeNull();
    expect(parseSubQuestions(JSON.stringify(null))).toBeNull();
  });
});

describe("decompose", () => {
  it("returns sub-questions on the happy path and sends the question as user data", async () => {
    const create = vi.fn().mockResolvedValue(okResponse(["a?", "b?"]));
    const result = await decompose("compound question?", fakeClient(create));
    expect(result).toEqual(["a?", "b?"]);
    const [params, options] = create.mock.calls[0];
    expect(params.model).toBe(DECOMPOSE_MODEL);
    expect(params.messages).toEqual([{ role: "user", content: "compound question?" }]);
    // Spec §8: the visitor's question must never be in the system prompt.
    expect(params.system).not.toContain("compound question?");
    // Spec §6: hard budget, no retries — fall back instead of retrying.
    expect(options).toMatchObject({ timeout: DECOMPOSE_TIMEOUT_MS, maxRetries: 0 });
  });

  it("returns null on a refusal stop reason", async () => {
    const create = vi.fn().mockResolvedValue({ ...okResponse(["a?"]), stop_reason: "refusal" });
    expect(await decompose("q?", fakeClient(create))).toBeNull();
  });

  it("returns null when the call rejects (errors and timeouts)", async () => {
    const create = vi.fn().mockRejectedValue(new Error("timed out"));
    expect(await decompose("q?", fakeClient(create))).toBeNull();
  });

  it("returns null when the response has no text block", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "end_turn", content: [] });
    expect(await decompose("q?", fakeClient(create))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/decompose.test.ts`
Expected: FAIL — `Cannot find module '../lib/decompose'` (or equivalent).

- [ ] **Step 3: Implement `lib/decompose.ts`**

```typescript
import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// Fixed constant, deliberately NOT ANSWER_MODEL(): upgrading the answering
// model must never silently make the splitter 25x more expensive (spec §4).
export const DECOMPOSE_MODEL = "claude-haiku-4-5";
export const MAX_SUB_QUESTIONS = 4;
export const DECOMPOSE_TIMEOUT_MS = 3_000;
export const MAX_DECOMPOSE_TOKENS = 512;

// Instructions only — the visitor's question goes in the user message as
// data, never concatenated here (spec §8).
export const DECOMPOSE_SYSTEM_PROMPT = `You split questions about the Laws of the Game (football/soccer rules) into retrieval-friendly sub-questions.

Return JSON: {"sub_questions": [...]}.

Rules:
- If the question asks about one rule or concept, return exactly one item: the question itself, unchanged.
- If it combines several distinct rules or scenarios, split it into 2-4 self-contained sub-questions, each answerable from a single section of the Laws.
- Each sub-question must stand alone: name its subject explicitly (no "it", "they", "that case").
- Never answer the question. Never invent sub-questions about topics the question does not raise.`;

const SUB_QUESTIONS_SCHEMA = {
  type: "object",
  properties: { sub_questions: { type: "array", items: { type: "string" } } },
  required: ["sub_questions"],
  additionalProperties: false,
};

export function parseSubQuestions(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const list = (parsed as { sub_questions?: unknown }).sub_questions;
  if (!Array.isArray(list)) return null;
  const cleaned = list
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_SUB_QUESTIONS);
  return cleaned.length === 0 ? null : cleaned;
}

// Resolves to 1-4 sub-questions, or null meaning "take the simple path".
// Never rejects: the decomposer is an optimization, not a dependency —
// every failure mode must land on today's exact behavior (spec §6).
export async function decompose(
  question: string,
  client: Anthropic = new Anthropic(),
): Promise<string[] | null> {
  try {
    const response = await client.messages.create(
      {
        model: DECOMPOSE_MODEL,
        max_tokens: MAX_DECOMPOSE_TOKENS,
        system: DECOMPOSE_SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: SUB_QUESTIONS_SCHEMA } },
        messages: [{ role: "user", content: question }],
      },
      { timeout: DECOMPOSE_TIMEOUT_MS, maxRetries: 0 },
    );
    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? parseSubQuestions(block.text) : null;
  } catch (err) {
    console.error("decompose failed", { question: question.slice(0, 80), err });
    return null;
  }
}
```

Note: `output_config.format` is the structured-outputs parameter (the API guarantees schema-valid JSON). If `npx tsc --noEmit` reports `output_config` as an unknown property on this SDK version, run `npm install @anthropic-ai/sdk@latest` and re-check — do not fall back to prompt-only JSON.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/decompose.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Full verification**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all green (existing suites untouched).

- [ ] **Step 6: Commit**

```bash
git add lib/decompose.ts tests/decompose.test.ts
git commit -m "feat: query decomposer call with strict JSON contract"
```

---

### Task 2: batch retrieval + merge in `lib/retrieval.ts`

**Files:**
- Modify: `lib/retrieval.ts` (currently 52 lines; `searchChunks` at lines 41–51)
- Test: `tests/retrieval.test.ts` (append), Create: `tests/retrieval-batch.test.ts`

**Interfaces:**
- Consumes: existing `embedTexts(texts: string[], "query"): Promise<number[][]>`, `serverSupabase()`, `resultFromRows`, `RetrievalResult`, `RetrievedChunk`.
- Produces:
  - `searchChunksBatch(questions: string[], k = 8): Promise<RetrievalResult[]>` — ONE Voyage embed call for all questions, then parallel `match_chunks` calls; returns the successful results only (per-question failures are logged and dropped); rejects only if the embed call itself fails.
  - `mergeResults(results: RetrievalResult[], cap = MERGED_CHUNK_CAP): RetrievalResult` — pure; rank round-robin, dedupe by id, cap; `maxSimilarity` = max across ALL inputs (even capped-out chunks).
  - `MERGED_CHUNK_CAP = 12`.
  - `searchChunks` signature unchanged.

- [ ] **Step 1: Write the failing merge tests**

Append to `tests/retrieval.test.ts` (extend the existing imports from `../lib/retrieval` with `mergeResults` and `MERGED_CHUNK_CAP`):

```typescript
describe("mergeResults", () => {
  const chunk = (id: number, similarity = 0.5): RetrievedChunk => ({
    id,
    law_number: 3,
    breadcrumb: `Law 3 › ${id}`,
    content: "…",
    similarity,
    rrf_score: 0.03,
  });
  const listOf = (...chunks: RetrievedChunk[]) => resultFromRows(chunks);

  it("round-robins by rank: every list's rank-1 chunk precedes any rank-2 chunk", () => {
    const merged = mergeResults([
      listOf(chunk(1), chunk(2)),
      listOf(chunk(3), chunk(4)),
      listOf(chunk(5)),
    ]);
    expect(merged.chunks.map((c) => c.id)).toEqual([1, 3, 5, 2, 4]);
  });

  it("dedupes by chunk id keeping the best-ranked occurrence", () => {
    const merged = mergeResults([listOf(chunk(1), chunk(2)), listOf(chunk(2), chunk(3))]);
    expect(merged.chunks.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("caps the merged set at the cap parameter", () => {
    const merged = mergeResults(
      [listOf(chunk(1), chunk(2)), listOf(chunk(3), chunk(4)), listOf(chunk(5), chunk(6))],
      3,
    );
    expect(merged.chunks.map((c) => c.id)).toEqual([1, 3, 5]);
  });

  it("defaults the cap to MERGED_CHUNK_CAP", () => {
    const lists = [0, 1].map((n) =>
      listOf(...Array.from({ length: 8 }, (_, i) => chunk(n * 100 + i))),
    );
    expect(mergeResults(lists).chunks).toHaveLength(MERGED_CHUNK_CAP);
  });

  it("maxSimilarity spans ALL inputs, including chunks dropped by the cap", () => {
    // Gate semantics (spec §5): abstain is decided on everything retrieved,
    // not just what survives the cap.
    const hot = listOf(chunk(9, 0.9));
    const cold = listOf(chunk(1, 0.2), chunk(2, 0.2));
    const merged = mergeResults([cold, hot], 1);
    expect(merged.chunks.map((c) => c.id)).toEqual([1]);
    expect(merged.maxSimilarity).toBe(0.9);
  });

  it("returns an empty result with maxSimilarity 0 for no inputs", () => {
    expect(mergeResults([])).toEqual({ chunks: [], maxSimilarity: 0 });
  });
});
```

- [ ] **Step 2: Write the failing batch-search tests**

Create `tests/retrieval-batch.test.ts` (separate file because it mocks `lib/voyage` and `lib/supabase`, which the existing `tests/retrieval.test.ts` imports for real):

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

const embedTexts = vi.fn();
vi.mock("../lib/voyage", () => ({
  embedTexts: (...args: unknown[]) => embedTexts(...args),
}));
const rpc = vi.fn();
vi.mock("../lib/supabase", () => ({ serverSupabase: () => ({ rpc }) }));

import { searchChunksBatch } from "../lib/retrieval";

const row = (id: number) => ({
  id,
  law_number: 3,
  breadcrumb: `Law 3 › ${id}`,
  content: "…",
  similarity: 0.5,
  rrf_score: 0.03,
});

afterEach(() => vi.clearAllMocks());

describe("searchChunksBatch", () => {
  it("embeds every sub-question in ONE Voyage call, then searches per question", async () => {
    // One call matters: Voyage free tier allows 3 requests/minute (spec §7).
    embedTexts.mockResolvedValue([[0.1], [0.2]]);
    rpc.mockResolvedValue({ data: [row(1)], error: null });
    const results = await searchChunksBatch(["a?", "b?"], 8);
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(embedTexts).toHaveBeenCalledWith(["a?", "b?"], "query");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      "match_chunks",
      expect.objectContaining({ query_text: "a?", match_count: 8 }),
    );
    expect(results).toHaveLength(2);
  });

  it("drops a failed match_chunks call and returns the successes (spec §6)", async () => {
    embedTexts.mockResolvedValue([[0.1], [0.2]]);
    rpc
      .mockResolvedValueOnce({ data: [row(1)], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const results = await searchChunksBatch(["a?", "b?"], 8);
    expect(results).toHaveLength(1);
    expect(results[0].chunks[0].id).toBe(1);
  });

  it("rejects when the embed call itself fails (route falls back to baseline)", async () => {
    embedTexts.mockRejectedValue(new Error("Voyage API 429"));
    await expect(searchChunksBatch(["a?"], 8)).rejects.toThrow("429");
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `npm test -- tests/retrieval.test.ts tests/retrieval-batch.test.ts`
Expected: FAIL — `mergeResults`, `MERGED_CHUNK_CAP`, `searchChunksBatch` not exported.

- [ ] **Step 4: Implement in `lib/retrieval.ts`**

Refactor `searchChunks` to share a private `matchChunks` helper, then add the two new exports. Replace the existing `searchChunks` (lines 41–51) with:

```typescript
async function matchChunks(
  embedding: number[],
  questionText: string,
  k: number,
): Promise<RetrievalResult> {
  const { data, error } = await serverSupabase().rpc("match_chunks", {
    query_embedding: embedding,
    query_text: questionText,
    match_count: k,
    version: CORPUS_VERSION,
  });
  if (error) throw new Error(`match_chunks failed: ${error.message}`);
  return resultFromRows((data ?? []) as RetrievedChunk[]);
}

export async function searchChunks(question: string, k = 8): Promise<RetrievalResult> {
  const [embedding] = await embedTexts([question], "query");
  return matchChunks(embedding, question, k);
}

// Merged-set size for compound questions (spec §5) — a bounded generation-cost
// increase over the per-query k=8, paid only on compound questions.
export const MERGED_CHUNK_CAP = 12;

// One Voyage call for all sub-questions (free tier: 3 requests/minute), then
// parallel match_chunks. Per-question failures are dropped, not fatal — the
// route merges whatever succeeded (spec §6). Rejects only if the embed fails.
export async function searchChunksBatch(
  questions: string[],
  k = 8,
): Promise<RetrievalResult[]> {
  const embeddings = await embedTexts(questions, "query");
  const settled = await Promise.allSettled(
    embeddings.map((embedding, i) => matchChunks(embedding, questions[i], k)),
  );
  const successes: RetrievalResult[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") successes.push(s.value);
    else console.error("sub-question search failed", { question: questions[i].slice(0, 80) });
  });
  return successes;
}

// Rank round-robin: every list's rank-1 chunk beats any list's rank-2 chunk,
// so each sub-question's best evidence survives the cap. Dedupe keeps the
// first (best-ranked) occurrence. maxSimilarity spans ALL inputs — the gate
// decides abstain on everything retrieved, not just what survived the cap.
export function mergeResults(
  results: RetrievalResult[],
  cap = MERGED_CHUNK_CAP,
): RetrievalResult {
  const merged: RetrievedChunk[] = [];
  const seen = new Set<number>();
  const maxLen = results.reduce((m, r) => Math.max(m, r.chunks.length), 0);
  outer: for (let rank = 0; rank < maxLen; rank++) {
    for (const r of results) {
      const c = r.chunks[rank];
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(c);
      if (merged.length >= cap) break outer;
    }
  }
  return {
    chunks: merged,
    maxSimilarity: results.reduce((m, r) => Math.max(m, r.maxSimilarity), 0),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/retrieval.test.ts tests/retrieval-batch.test.ts`
Expected: PASS (all, including the pre-existing relevance-gate tests).

- [ ] **Step 6: Full verification**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add lib/retrieval.ts tests/retrieval.test.ts tests/retrieval-batch.test.ts
git commit -m "feat: batch sub-question retrieval and rank-merge"
```

---

### Task 3 (REVISED 2026-07-15 — see plan note below): route wiring — elapsed-aware soft-deadline decompose race + merge

> **Why this task was rewritten:** the first attempt at this task (superseded, reverted) implemented `Promise.all([searchChunks(question, 8), decompose(question)])`. A task-review pass found that `Promise.all` blocks *every* request — including simple ones — on decompose's full ~3s latency, contradicting the spec's Goal 2 ("added wait ≈ 0"). This was escalated, redesigned (`superpowers:brainstorming`), reviewed by Fable across three rounds, and merged into the spec via PR #49. This task now implements that corrected design: an elapsed-aware soft-deadline race, spec §3/§4/§7/§9/§10.4.
>
> **Plan-level review (2026-07-15, PR #50):** before any implementer built against this revised plan, Fable reviewed the plan document itself (not just the spec) — and, notably, actually ran the given route code and test code empirically rather than only reading it. Found 1 BLOCKER here: both new fake-timer tests would hang/timeout deterministically, because `lib/session.ts`'s real WebCrypto work (session-token creation and verification) doesn't advance under `vi.useFakeTimers()`, so the tests' timer-advancement call would fire before the route ever reached the point of registering the soft-deadline timer. Fixed below (Step 2/3) by mocking `verifySessionToken` and precomputing the request before enabling fake timers — Fable validated this exact fix makes the test pass in ~20ms. The elapsed-aware race logic itself (the actual design) was confirmed correct by the same empirical run — no `Promise.all`-class bug in the mechanism, only in the test scaffolding.
>
> **Independent fresh-context review (2026-07-15, PR #50):** a separately-dispatched review with no memory of the rounds above (given only the merged spec and this plan, not told what was already found) independently re-confirmed the elapsed-aware race and the fake-timer fix are both correct, and additionally caught that Step 4's "all seven new tests FAIL" claim was wrong — 4 of the 7 new tests already pass against the unwired route (regression guards, not RED tests). Fixed in Step 4 below.

**Files:**
- Modify: `lib/decompose.ts` (add one export: `DECOMPOSE_SOFT_DEADLINE_MS`)
- Modify: `app/api/ask/route.ts` (retrieval block currently at lines 95–101 — the reverted first attempt's code; if the revert already ran, this is the same block as originally: `let retrieval; try { retrieval = await searchChunks(question, 8); } ...`)
- Test: `tests/ask-route.test.ts` (extend), `tests/decompose.test.ts` (no changes needed — the new constant is a plain literal, already covered by the file compiling and existing tests passing)

**Interfaces:**
- Consumes: `decompose`, `DECOMPOSE_SOFT_DEADLINE_MS` (`lib/decompose.ts`), `searchChunksBatch`, `mergeResults` (`lib/retrieval.ts`, Task 2).
- Produces: no new route-level exports — behavior only. Simple path uses identical chunks/gate outcome to today whenever decompose answers within budget (spec §2 Goal 2, revised); latency is *bounded*, not unconditionally unchanged — spec §7.

- [ ] **Step 1: Add the soft-deadline constant**

In `lib/decompose.ts`, add beside the existing `DECOMPOSE_TIMEOUT_MS`:

```typescript
// Route-level deadline (app/api/ask/route.ts) for how long /api/ask waits on
// this call before proceeding as simple for the current request — NOT a
// property of decompose() itself, whose own contract (never rejects, this
// file's ~3s hard budget above) is unchanged. See spec §3/§4. Initial
// estimate pending Task 5's latency-sampling validation.
export const DECOMPOSE_SOFT_DEADLINE_MS = 800;
```

Run: `npm test -- tests/decompose.test.ts`
Expected: PASS (all 11, unaffected — this is an additive export, no behavior change to `decompose()` or `parseSubQuestions`).

- [ ] **Step 2: Extend the route test mocks**

In `tests/ask-route.test.ts`, the module mocks at the top must now also cover `decompose`, `DECOMPOSE_SOFT_DEADLINE_MS`, `searchChunksBatch`, AND `verifySessionToken`. Add beside the existing `const searchChunks = vi.fn();`:

```typescript
const searchChunksBatch = vi.fn();
const decompose = vi.fn();
const verifySessionToken = vi.fn();
```

Extend the existing `vi.mock("../lib/retrieval", ...)` factory's returned object with:

```typescript
  searchChunksBatch: (...args: unknown[]) => searchChunksBatch(...args),
```

(`mergeResults` stays REAL via the existing `importOriginal` spread — it is pure and worth exercising.) Add a new mock block beside the others — this one ALSO spreads `importOriginal` so the real `DECOMPOSE_SOFT_DEADLINE_MS` value is available to the fake-timer tests below, while `decompose` itself stays mocked:

```typescript
vi.mock("../lib/decompose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/decompose")>();
  return {
    ...actual,
    decompose: (...args: unknown[]) => decompose(...args),
  };
});
```

**Also mock `verifySessionToken`** (Fable's design review on PR #50 found this is required — see the note below the two new tests for why). Add beside the `lib/decompose` mock:

```typescript
vi.mock("../lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/session")>();
  return {
    ...actual,
    verifySessionToken: (...args: unknown[]) => verifySessionToken(...args),
  };
});
```

Add the import at the top of the test file (this is the REAL constant, per the spread above):

```typescript
import { DECOMPOSE_SOFT_DEADLINE_MS } from "../lib/decompose";
```

In the existing `beforeEach` (make it `async` — it needs to `await` below), add a default so every pre-existing test runs the simple path unchanged, AND default `verifySessionToken` to the REAL implementation so every pre-existing test's session-verification behavior is unaffected:

```typescript
  decompose.mockResolvedValue(null);
  const actualSession = await vi.importActual<typeof import("../lib/session")>("../lib/session");
  verifySessionToken.mockImplementation(actualSession.verifySessionToken);
```

Add one more helper beside the existing `post()` function — this builds the request (including the real, cryptographically-signed session cookie) eagerly, so it can be constructed BEFORE fake timers are enabled in the two new tests below:

```typescript
async function buildRequest(body: unknown) {
  const req = new NextRequest("http://localhost/api/ask", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  req.cookies.set(SESSION_COOKIE, await createSessionToken(SECRET));
  req.cookies.set(VISITOR_COOKIE, "vis-1");
  return req;
}
```

- [ ] **Step 3: Write the failing tests**

Append to the `describe("POST /api/ask", ...)` block. The first five exercise the merge/fallback/gate/rate-limit behavior (unaffected by the timing refinement — these mocks resolve instantly, which always beats the soft deadline); the last two exercise the soft-deadline race itself (spec §9):

```typescript
  const chunkRow2 = { ...chunkRow, id: 2, breadcrumb: "Law 10 › 2. Winning team" };

  it("keeps the simple path when decompose returns one sub-question or null", async () => {
    decompose.mockResolvedValue(["when is a player offside?"]);
    const res = await post({ question: "when is a player offside?" });
    expect(res.status).toBe(200);
    expect(searchChunksBatch).not.toHaveBeenCalled();
  });

  it("merges sub-question retrievals and answers with the ORIGINAL question", async () => {
    decompose.mockResolvedValue(["what abandons a match?", "is there a shoot-out?"]);
    searchChunksBatch.mockResolvedValue([
      { chunks: [chunkRow2], maxSimilarity: chunkRow2.similarity },
    ]);
    const res = await post({ question: "what happens if everyone is sent off?" });
    const body = await res.text();
    expect(searchChunksBatch).toHaveBeenCalledWith(
      ["what abandons a match?", "is there a shoot-out?"],
      8,
    );
    // meta carries the merged set (both chunk ids)
    expect(body).toContain('"id":1');
    expect(body).toContain('"id":2');
    // spec §3: the answering model sees the visitor's original question only
    expect(streamAnswer).toHaveBeenCalledWith(
      "what happens if everyone is sent off?",
      expect.arrayContaining([
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 }),
      ]),
    );
  });

  it("falls back to the baseline result when sub-question retrieval throws", async () => {
    decompose.mockResolvedValue(["a?", "b?"]);
    searchChunksBatch.mockRejectedValue(new Error("Voyage API 429"));
    const res = await post({ question: "compound?" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: text"); // still streams from baseline chunks
    expect(streamAnswer).toHaveBeenCalledWith("compound?", [chunkRow]);
  });

  it("gates on the MERGED max similarity", async () => {
    // Baseline is sub-threshold; a sub-question result clears it — merged
    // max decides (spec §5), so this streams instead of gating.
    searchChunks.mockResolvedValue({
      chunks: [{ ...chunkRow, similarity: RELEVANCE_THRESHOLD - 0.05 }],
      maxSimilarity: RELEVANCE_THRESHOLD - 0.05,
    });
    decompose.mockResolvedValue(["a?", "b?"]);
    searchChunksBatch.mockResolvedValue([
      { chunks: [chunkRow2], maxSimilarity: RELEVANCE_THRESHOLD + 0.1 },
    ]);
    const res = await post({ question: "compound?" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("never calls decompose for rate-limited questions (paid call after count)", async () => {
    recordQuestion.mockResolvedValue({ visitorCount: 21, globalCount: 50 });
    await post({ question: "offside?" });
    expect(decompose).not.toHaveBeenCalled();
  });

  it("treats a slow decompose as simple once the soft deadline elapses (spec §3, §6)", async () => {
    // Build the request (real WebCrypto session-token signing) BEFORE
    // enabling fake timers, and mock verifySessionToken (also real
    // WebCrypto — see route.ts's first line) so nothing in this test needs
    // a genuine event-loop turn to resolve once fake timers are active.
    // Fable's design review on PR #50 found this by actually running the
    // test: WebCrypto's async work doesn't advance with vi's fake timers,
    // so a single vi.advanceTimersByTimeAsync() call would sweep before the
    // route ever reached the point of registering the soft-deadline timer,
    // making the test hang/timeout every run.
    const req = await buildRequest({ question: "compound?" });
    verifySessionToken.mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      let resolveDecompose: (v: string[] | null) => void = () => {};
      decompose.mockImplementation(
        () => new Promise<string[] | null>((resolve) => { resolveDecompose = resolve; }),
      );
      const resPromise = POST(req);
      await vi.advanceTimersByTimeAsync(DECOMPOSE_SOFT_DEADLINE_MS + 50);
      const res = await resPromise;
      expect(res.status).toBe(200);
      expect(searchChunksBatch).not.toHaveBeenCalled();

      // The late answer arrives after the response was already produced —
      // it must have no further effect (spec §6, "answers after the soft
      // deadline" row).
      resolveDecompose(["a?", "b?"]);
      await vi.runAllTimersAsync();
      expect(searchChunksBatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a decompose answer that already resolved while baseline retrieval was the slow one (spec §3 elapsed-aware deadline)", async () => {
    // If baseline alone already used up the whole soft-deadline budget, an
    // ALREADY-RESOLVED decompose answer must still be used — not discarded
    // by a fixed wall-clock cutoff measured from request start. This is the
    // property Fable's design review specifically asked to be tested.
    // Same buildRequest + verifySessionToken mock as the test above, for
    // the same WebCrypto-vs-fake-timers reason.
    const req = await buildRequest({ question: "what happens if everyone is sent off?" });
    verifySessionToken.mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      decompose.mockResolvedValue(["what abandons a match?", "is there a shoot-out?"]);
      searchChunksBatch.mockResolvedValue([
        { chunks: [chunkRow2], maxSimilarity: chunkRow2.similarity },
      ]);
      searchChunks.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ chunks: [chunkRow], maxSimilarity: chunkRow.similarity }),
              DECOMPOSE_SOFT_DEADLINE_MS + 100,
            );
          }),
      );
      const resPromise = POST(req);
      await vi.advanceTimersByTimeAsync(DECOMPOSE_SOFT_DEADLINE_MS + 150);
      const res = await resPromise;
      expect(res.status).toBe(200);
      expect(searchChunksBatch).toHaveBeenCalledWith(
        ["what abandons a match?", "is there a shoot-out?"],
        8,
      );
    } finally {
      vi.useRealTimers();
    }
  });
```

**Import note:** `POST` is already imported from `../app/api/ask/route` at the top of this file (the existing `post()` helper calls it); the two tests above call it directly since they need to control exactly when the request is built relative to `vi.useFakeTimers()`.

- [ ] **Step 4: Run to verify the new tests fail**

Run: `npm test -- tests/ask-route.test.ts`

**Expected (corrected 2026-07-15 — an independent fresh-context review of this plan traced this by hand and found the original "all seven FAIL" claim was wrong, which would have confused a literal TDD implementer):** only 3 of the 7 new tests actually FAIL against the current, unwired route — `merges sub-question retrievals and answers with the ORIGINAL question`, `gates on the MERGED max similarity`, and `uses a decompose answer that already resolved while baseline retrieval was the slow one` (these three assert that `searchChunksBatch` was actually invoked or that gating used a merged result — the unwired route never merges, so these correctly fail). The other 4 — `keeps the simple path when decompose returns one sub-question or null`, `falls back to the baseline result when sub-question retrieval throws`, `never calls decompose for rate-limited questions`, and `treats a slow decompose as simple once the soft deadline elapses` — already PASS against the unwired route, because they only assert behavior the current simple-only code already exhibits (e.g. "decompose is never called" is trivially true when decompose isn't wired in at all yet). This is expected and correct — they're regression guards for behavior that must stay true after wiring, not RED-phase tests. Do not treat their early pass as a sign anything is wrong. All pre-existing tests still pass.

- [ ] **Step 5: Wire the route**

In `app/api/ask/route.ts`, add imports:

```typescript
import { decompose, DECOMPOSE_SOFT_DEADLINE_MS } from "@/lib/decompose";
import { isRelevant, mergeResults, searchChunks, searchChunksBatch } from "@/lib/retrieval";
```

Replace the retrieval block (currently lines 95–101, the `let retrieval; try { retrieval = await searchChunks(question, 8); } ...`) with:

```typescript
  // Parallel decompose-and-retrieve, elapsed-aware soft deadline (spec §3):
  // both calls fire concurrently; the route awaits baseline first (as it
  // always did), then gives decompose only whatever's left of
  // DECOMPOSE_SOFT_DEADLINE_MS since both calls started. If baseline alone
  // already used the whole budget, an already-resolved decompose answer is
  // used for free instead of being discarded by a fixed wall-clock cutoff.
  // decompose() never rejects (lib/decompose.ts) — the only rejection this
  // block can see is from searchChunks, which is fatal today too.
  let retrieval;
  const decomposeStart = Date.now();
  const subsPromise = decompose(question);
  try {
    retrieval = await searchChunks(question, 8);
  } catch (err) {
    console.error("retrieval failed", { question: question.slice(0, 80), err });
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }
  const remainingMs = Math.max(0, DECOMPOSE_SOFT_DEADLINE_MS - (Date.now() - decomposeStart));
  const softTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), remainingMs));
  const subQuestions = await Promise.race([subsPromise, softTimeout]);

  // Compound path: retrieve per sub-question, merge with the baseline.
  // Every failure lands on the baseline result already in hand (spec §6).
  if (subQuestions && subQuestions.length >= 2) {
    try {
      const subResults = await searchChunksBatch(subQuestions, 8);
      if (subResults.length > 0) retrieval = mergeResults([retrieval, ...subResults]);
    } catch (err) {
      console.error("sub-question retrieval failed", { question: question.slice(0, 80), err });
    }
  }
```

Everything downstream (`isRelevant` gate, `meta` event, `streamAnswer(question, retrieval.chunks)`) is untouched.

- [ ] **Step 6: Run the route tests**

Run: `npm test -- tests/ask-route.test.ts`
Expected: PASS (all 7 new, all pre-existing).

- [ ] **Step 7: Full verification including build**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green (`build` catches App Router-specific breakage).

- [ ] **Step 8: Commit**

```bash
git add lib/decompose.ts app/api/ask/route.ts tests/ask-route.test.ts
git commit -m "feat: elapsed-aware soft-deadline decompose race in ask route"
```

---

### Task 4: eval `--decompose` mode

**Files:**
- Modify: `evals/run-evals.ts`

**Interfaces:**
- Consumes: `decompose` (Task 1), `searchChunksBatch`, `mergeResults`, `MERGED_CHUNK_CAP` (Task 2), existing `coverageScore`, `searchChunks`.
- Produces: `npm run eval -- --decompose` runs ONLY the compound tier through the decomposed path and prints a baseline-vs-decomposed coverage comparison. The default `npm run eval` output is byte-for-byte unchanged.

No new pure logic → no new unit tests (`coverageScore` is already tested in `tests/evals.test.ts`); verification is running the mode.

- [ ] **Step 1: Generalize the retry helper**

In `evals/run-evals.ts`, replace `searchWithRetry` (lines 55–70) with a thunk-based version, keeping the same backoff behavior, and re-derive the old signature:

```typescript
// Voyage's free tier (no payment method on file) is rate-limited to 3 requests/minute.
// Retry with backoff on 429s so the eval run survives the free-tier limit end to end.
async function withVoyageRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("429") || attempt === maxAttempts) throw err;
      const backoffMs = 20_000 * attempt;
      console.error(
        `  (rate limited, retry ${attempt}/${maxAttempts - 1} in ${backoffMs / 1000}s)`,
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("unreachable");
}

const searchWithRetry = (question: string, k: number) =>
  withVoyageRetry(() => searchChunks(question, k));
```

- [ ] **Step 2: Add the decomposed compound runner**

Add imports at the top of `evals/run-evals.ts`:

```typescript
import { decompose } from "../lib/decompose";
import { mergeResults, MERGED_CHUNK_CAP, searchChunksBatch } from "../lib/retrieval";
```

Add the runner beside `runCompoundSet`:

```typescript
// Opt-in (--decompose): runs the compound tier through the production
// decompose → multi-retrieve → merge path. Paid (~9 Haiku calls, ~a cent)
// and mildly nondeterministic (an LLM chooses the split) — which is why it
// is not part of the default, free, deterministic run.
async function runCompoundSetDecomposed(compounds: CompoundQuestion[]): Promise<void> {
  const K = 8;
  let baseFull = 0;
  let decFull = 0;
  let baseSum = 0;
  let decSum = 0;
  for (const c of compounds) {
    const baseline = await searchWithRetry(c.question, K);
    const subs = await decompose(c.question);
    let merged = baseline;
    let subCount = 1;
    if (subs && subs.length >= 2) {
      subCount = subs.length;
      const subResults = await withVoyageRetry(() => searchChunksBatch(subs, K));
      if (subResults.length > 0) merged = mergeResults([baseline, ...subResults]);
    }
    const base = coverageScore(baseline.chunks, c.required);
    const dec = coverageScore(merged.chunks, c.required);
    baseSum += base.coverage;
    decSum += dec.coverage;
    if (base.missed.length === 0) baseFull += 1;
    if (dec.missed.length === 0) decFull += 1;
    console.log(
      `base ${c.required.length - base.missed.length}/${c.required.length}` +
        ` → decomposed ${c.required.length - dec.missed.length}/${c.required.length}` +
        `  (${subCount} sub-question${subCount === 1 ? "" : "s"})  ${c.question}`,
    );
    if (subs && subs.length >= 2) console.log(`  subs: ${subs.join(" | ")}`);
    if (dec.missed.length > 0) console.log(`  still missed: ${dec.missed.join(" | ")}`);
  }
  console.log(
    `\n[compound --decompose] n=${compounds.length}, k=${K}/query, merged cap ${MERGED_CHUNK_CAP}:`,
  );
  console.log(`  full coverage: baseline ${baseFull}/${compounds.length}` +
    ` → decomposed ${decFull}/${compounds.length}`);
  console.log(`  mean coverage: baseline ${(baseSum / compounds.length).toFixed(2)}` +
    ` → decomposed ${(decSum / compounds.length).toFixed(2)}`);
}
```

- [ ] **Step 3: Gate on the flag in `main()`**

As the very first statements of `main()` (before the four `readFile` calls — the mode loads the one file it needs and returns), add:

```typescript
  if (process.argv.includes("--decompose")) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("--decompose requires ANTHROPIC_API_KEY (decomposition is a Claude call)");
    }
    const compounds: CompoundQuestion[] = JSON.parse(
      await readFile("evals/compound-questions.json", "utf8"),
    );
    console.log("=== Compound set, decomposed retrieval (opt-in; paid; nondeterministic) ===");
    await runCompoundSetDecomposed(compounds);
    return;
  }
```

- [ ] **Step 4: Verify the default run is unchanged and the mode works**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: green.

Run: `npm run eval -- --decompose`
Expected: prints the comparison table for all 9 compound questions and a summary; decomposed full coverage ≥ baseline full coverage. (Numbers are recorded in Task 5, but eyeball here that decomposition actually splits the red-card question into ≥2 subs.)

Note: `npm run eval` (default) is deliberately NOT run in this step — it takes many minutes under the free-tier backoff and nothing on its path changed in this task. It runs once, in Task 5, as the regression gate.

- [ ] **Step 5: Commit**

```bash
git add evals/run-evals.ts
git commit -m "feat: opt-in --decompose eval mode for the compound tier"
```

---

### Task 5: measurement, regression gate, docs

> **Note (2026-07-15):** the soft-deadline measurement steps below (revised
> per Fable's design review on PR #49) replace the original latency-sampling
> step from this session's earlier Task-5 amendment. That original step
> assumed the reverted `Promise.all` mechanism and is superseded by Task 3's
> elapsed-aware soft-deadline race — see spec §7/§10.4.
>
> **Plan-level review (2026-07-15, PR #50):** Fable's review of this plan
> revision (not just the spec) found a second BLOCKER: Step 2a/2b below
> measured only the soft-deadline miss rate, but spec §10.4 requires BOTH
> that AND confirming simple-question added latency is actually small in
> practice — the earlier revision dropped that second half entirely when it
> replaced the stale `Promise.all`-based script. Fixed: Step 2c below restores
> the simple-question latency sample, rewritten to exercise Task 3's actual
> elapsed-aware mechanism instead of the old one.
>
> **Independent fresh-context review (2026-07-15, PR #50):** a review with
> no prior context on this session's back-and-forth (deliberately dispatched
> fresh, given only the merged spec and this plan — not told what earlier
> rounds already found) caught two things the earlier, more leading review
> rounds missed: (1) **BLOCKER, fixed** — Step 2c's throwaway script fired 10
> back-to-back Voyage calls with no spacing and no `.catch` on `main()`,
> which would 429-crash around question 4; fixed with 21s spacing between
> samples (avoiding the need for retry/backoff, which would have
> re-introduced the same measurement contamination the spec's own caveat
> warns about) and an error handler. (2) **Confirmed as a real sequencing
> gap, not yet fixed in this note** — this task's file list and Step 2a both
> assume Task 4 (`runCompoundSetDecomposed` in `evals/run-evals.ts`) is
> already implemented and merged into this branch. It is NOT — verified via
> `grep -n "runCompoundSetDecomposed\|--decompose" evals/run-evals.ts`
> returning zero matches at the time of this review. **Task 4 must be
> executed (per its own section below) before Step 2a of this task can run**
> — the Execution notes' original dependency ordering ("Task 5 needs all")
> already said this; this session's redesign work lost track of it along
> the way.

**Files:**
- Modify: `evals/run-evals.ts` (add soft-deadline timing to `runCompoundSetDecomposed` — **requires Task 4 to be complete first**, since that function doesn't exist until Task 4 builds it)
- Modify: `docs/superpowers/specs/2026-07-15-query-decomposition-design.md` (revision history)
- Modify: `docs/project-reviewer.md` (compound-question / decomposition talking point)
- Modify: `README.md` (known-limitation line)

**Interfaces:**
- Consumes: everything above, complete and merged into the feature branch; `DECOMPOSE_SOFT_DEADLINE_MS` (`lib/decompose.ts`, Task 3).
- Produces: recorded before/after numbers; the regression bar (spec §10, including the new §10.4 soft-deadline acceptance threshold) checked; docs updated.

- [ ] **Step 1: Run the full regression gate**

Run, in order:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
npm run eval
```

Expected: golden 30/30 recall@8, paraphrase and abstain results identical to the recorded baseline (the default path is untouched code), everything else green. If ANY of these regress, STOP — the task is blocked; do not proceed to measurement.

- [ ] **Step 2a: Add soft-deadline timing to the eval runner**

Spec §10.4 requires measuring how often `decompose()`'s real latency exceeds `DECOMPOSE_SOFT_DEADLINE_MS`, timed directly — NOT inferred from the eval harness's own elapsed wall-clock time, which is contaminated by `withVoyageRetry`'s 20s×attempt backoff on the *other* calls in the loop (the Voyage embed calls) and would make the miss rate look artificially low (Fable's design-review follow-up finding on PR #49). `decompose()` itself is never wrapped in `withVoyageRetry` — only `searchWithRetry`/the sub-question embed call are — so timing it directly, right where it's already called, gives the real number for free.

In `evals/run-evals.ts`, add `DECOMPOSE_SOFT_DEADLINE_MS` to the existing import from `../lib/decompose`:

```typescript
import { decompose, DECOMPOSE_SOFT_DEADLINE_MS } from "../lib/decompose";
```

Replace `runCompoundSetDecomposed` (from Task 4) with this version — the only changes are the added `decomposeStart`/`decomposeMs`/`softDeadlineMisses` tracking and the new summary line; coverage logic is untouched:

```typescript
async function runCompoundSetDecomposed(compounds: CompoundQuestion[]): Promise<void> {
  const K = 8;
  let baseFull = 0;
  let decFull = 0;
  let baseSum = 0;
  let decSum = 0;
  let softDeadlineMisses = 0;
  for (const c of compounds) {
    const baseline = await searchWithRetry(c.question, K);
    const decomposeStart = Date.now();
    const subs = await decompose(c.question);
    const decomposeMs = Date.now() - decomposeStart;
    if (decomposeMs > DECOMPOSE_SOFT_DEADLINE_MS) softDeadlineMisses += 1;
    let merged = baseline;
    let subCount = 1;
    if (subs && subs.length >= 2) {
      subCount = subs.length;
      const subResults = await withVoyageRetry(() => searchChunksBatch(subs, K));
      if (subResults.length > 0) merged = mergeResults([baseline, ...subResults]);
    }
    const base = coverageScore(baseline.chunks, c.required);
    const dec = coverageScore(merged.chunks, c.required);
    baseSum += base.coverage;
    decSum += dec.coverage;
    if (base.missed.length === 0) baseFull += 1;
    if (dec.missed.length === 0) decFull += 1;
    console.log(
      `base ${c.required.length - base.missed.length}/${c.required.length}` +
        ` → decomposed ${c.required.length - dec.missed.length}/${c.required.length}` +
        `  (${subCount} sub-question${subCount === 1 ? "" : "s"}, decompose ${decomposeMs}ms)  ${c.question}`,
    );
    if (subs && subs.length >= 2) console.log(`  subs: ${subs.join(" | ")}`);
    if (dec.missed.length > 0) console.log(`  still missed: ${dec.missed.join(" | ")}`);
  }
  console.log(
    `\n[compound --decompose] n=${compounds.length}, k=${K}/query, merged cap ${MERGED_CHUNK_CAP}:`,
  );
  console.log(`  full coverage: baseline ${baseFull}/${compounds.length}` +
    ` → decomposed ${decFull}/${compounds.length}`);
  console.log(`  mean coverage: baseline ${(baseSum / compounds.length).toFixed(2)}` +
    ` → decomposed ${(decSum / compounds.length).toFixed(2)}`);
  const missRatePct = (softDeadlineMisses / compounds.length) * 100;
  console.log(
    `  soft-deadline (${DECOMPOSE_SOFT_DEADLINE_MS}ms) miss rate: ${softDeadlineMisses}/${compounds.length}` +
      ` (${missRatePct.toFixed(0)}%) — acceptance bar: must be under 20% (spec §10.4)`,
  );
}
```

No new pure logic is introduced (this is timing instrumentation on an existing eval script, not product code) — no new unit test required, matching Task 4's own "no new pure logic → no new unit tests" note. Verification is running the mode (Step 2b below) — but since `tsx` doesn't typecheck ahead of time, run `npx tsc --noEmit` first to catch any slip in this edit before it lands in the commit (a second independent review, PR #50, flagged this step was otherwise the only one in the whole plan that edits real TypeScript without a typecheck immediately after).

Run: `npx tsc --noEmit`
Expected: clean (no new errors from this edit).

- [ ] **Step 2b: Run the measurement**

Run: `npm run eval -- --decompose` (twice, per the existing nondeterminism-check requirement below)

Record from the summary block, for BOTH runs: baseline full coverage (expected 3/9), decomposed full coverage, both mean coverages, the per-question line for the red-card question ("What happens if everyone on a team gets a red card?") including its sub-questions, AND the new soft-deadline miss-rate line. Because the split is nondeterministic, if the two runs' full-coverage counts differ, record both and flag it in the PR description.

**Regression bar §10.4 check:** if the miss rate is at or above 20% on EITHER run, this bar fails — STOP, do not proceed to Step 2c. Raise `DECOMPOSE_SOFT_DEADLINE_MS` in `lib/decompose.ts` (e.g. to 1200 or 1500ms) and re-run this step until both runs are under 20%, or escalate to Markus if raising the deadline doesn't help (which would suggest a deeper problem, not a tuning issue).

- [ ] **Step 2c: Sample simple-question latency under the soft-deadline race (spec §7, §10.4)**

Regression bar §10.4 requires BOTH the miss-rate measurement above AND confirming simple-question added latency is actually small in practice (Fable's design review on PR #50 found the plan's earlier revision measured only the miss rate and dropped this half — flagged as a BLOCKER). This must exercise the ACTUAL elapsed-aware mechanism from Task 3, not the old `Promise.all` shape.

**Wait ~30s before starting this step** if Step 2b's runs just finished — a second independent review (PR #50) noted Step 2b's own Voyage calls (two full `--decompose` runs) can leave the free tier's rate window still hot, and this step's first call has no spacing before it (only between samples) since it assumes a clean slate.

Create a throwaway script (do not commit it) at `scripts/tmp-latency-sample.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { decompose, DECOMPOSE_SOFT_DEADLINE_MS } from "../lib/decompose";
import { searchChunks } from "../lib/retrieval";

interface GoldenQuestion {
  question: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const golden: GoldenQuestion[] = JSON.parse(await readFile("evals/golden-questions.json", "utf8"));
  const sample = golden.slice(0, 10);
  const addedMsSamples: number[] = [];
  for (let i = 0; i < sample.length; i++) {
    // Space calls 21s apart -- Voyage's free tier is 3 requests/minute (one
    // every ~20s) -- so this raw, single-attempt timing never hits a 429 and
    // is never contaminated by retry/backoff (the same contamination the
    // spec's own caveat warns about for the compound-tier miss-rate
    // measurement — an independent plan review, 2026-07-15, caught that the
    // original version of this script had neither spacing nor a catch on
    // main(), and would 429-crash around question 4).
    if (i > 0) await sleep(21_000);
    const { question } = sample[i];
    // Mirrors app/api/ask/route.ts's retrieval block exactly (Task 3).
    const decomposeStart = Date.now();
    const subsPromise = decompose(question);
    const baselineStart = Date.now();
    await searchChunks(question, 8);
    const baselineMs = Date.now() - baselineStart;
    const remainingMs = Math.max(0, DECOMPOSE_SOFT_DEADLINE_MS - (Date.now() - decomposeStart));
    const softTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), remainingMs));
    await Promise.race([subsPromise, softTimeout]);
    const totalMs = Date.now() - decomposeStart;
    const addedMs = Math.max(0, totalMs - baselineMs);
    addedMsSamples.push(addedMs);
    console.log(`${question.slice(0, 60)}  baseline=${baselineMs}ms total=${totalMs}ms added=${addedMs}ms`);
  }
  const sorted = [...addedMsSamples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const max = sorted[sorted.length - 1];
  console.log(`\nsimple-question added latency (n=${sample.length}): p50=${p50}ms max=${max}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

Run: `npx cross-env NODE_OPTIONS="--experimental-websocket --conditions=react-server" tsx --env-file=.env.local scripts/tmp-latency-sample.ts` (same invocation shape as `npm run eval`, since this script also imports `server-only`-guarded modules). This spends ~10 extra Haiku calls (a small fraction of a cent) and takes ~3-4 minutes wall-clock (the 21s spacing) — acceptable within Task 5's already-budgeted paid steps. Delete the script when done; it is throwaway per this step's own instruction.

Record the p50/max added-latency numbers (labeled "max," not "p95" — with only 10 samples, the 95th percentile is really just the largest observed value; calling it "p95" would overstate the statistical precision). If the max is comfortably sub-second (ideally near-zero, matching §7's "added wait ≈ 0 in the common case" framing), this half of the §10.4 bar passes. If it is not negligible, this is in tension with the miss-rate bar (raising `DECOMPOSE_SOFT_DEADLINE_MS` helps miss-rate but hurts latency, and vice versa) — if no single value satisfies both bars, STOP and escalate to Markus rather than picking one arbitrarily.

- [ ] **Step 3: Record the numbers in the spec's revision history**

Append a row to the revision-history table in `docs/superpowers/specs/2026-07-15-query-decomposition-design.md`:

```markdown
| 2026-MM-DD | Measured: compound full coverage N/9 → M/9 (mean 0.NN → 0.NN) with --decompose (run 1); N/9 → M/9 (run 2 if different); red-card question X/4 → Y/4. Soft-deadline (DECOMPOSE_SOFT_DEADLINE_MS=NNNms) miss rate: N/9 (P%) run 1, N/9 (P%) run 2 — under the 20% acceptance bar (spec §10.4). Simple-question added latency: p50 ~Nms, max ~Nms (n=10). |
```

(Fill the real values; keep the date current.)

- [ ] **Step 4: Update the README known-limitation line**

Find it: `grep -n -i "compound\|multi-part\|k=8" README.md`

The existing line frames compound-question coverage as a documented boundary of a k=8 demo. Replace it with user-facing phrasing along these lines (adapt to surrounding text, keep the honest-limitations tone):

```markdown
Compound questions (several rules at once) are split into sub-questions behind
the scenes and retrieved per concept; hard multi-law questions improved from
N/9 to M/9 full-coverage in our eval. Single-topic questions are unaffected.
```

- [ ] **Step 5: Update the interview guide**

In `docs/project-reviewer.md`, find the compound-question section (`grep -n -i "compound" docs/project-reviewer.md`) and extend it with 3–5 sentences: the measured baseline justified decomposition over raising k (2/9 questions unfixable at k=24); the elapsed-aware soft-deadline race bounds simple-question latency instead of leaving it at baseline exactly (a task-review + design-review finding worth mentioning as an interview talking point — the reference implementation's naive `Promise.all` would have blocked every request on decompose's full latency); the fallback contract means the decomposer can never make retrieval worse than today; before/after coverage numbers and the soft-deadline miss rate.

- [ ] **Step 6: Commit**

```bash
git add evals/run-evals.ts docs/superpowers/specs/2026-07-15-query-decomposition-design.md docs/project-reviewer.md README.md
git commit -m "docs: record query-decomposition measurement + README update"
```

- [ ] **Step 7: HUMAN CHECKPOINT — end-to-end acceptance (blocking)**

Spec §10.3: after the branch deploys (post-merge, Railway), Markus asks the original red-card question in the live app and confirms the ruling says an abandoned match does NOT become a penalty shoot-out. This is a manual check (the password gate blocks agent click-testing). **Per the global workflow rule, this unfinished verification BLOCKS calling the feature done** — track it explicitly in the PR/handoff; do not let it slide into a footnote.

---

## Execution notes

- Tasks 1 and 2 are independent of each other; Task 3 needs both; Task 4 needs 1+2; Task 5 needs all.
- Per the global CLAUDE.md rule, every implementer subagent dispatch must state the working directory AND branch, and its prompt must require `cd [directory] && pwd && git branch --show-current` as the literal first command, stopping as BLOCKED on any mismatch. **This session executes in a worktree** (`superpowers:using-git-worktrees`), not the main checkout — the required directory is `C:\ClaudeProjects\the-fourth-official\.claude\worktrees\feat+query-decomposition`, not `C:\ClaudeProjects\the-fourth-official` (the latter stays on `main`). Use whichever directory this session's worktree actually lives at if resumed elsewhere.
- Task 1's review battery additionally includes `/security-review` + the `security-reviewer` agent (spec §9).
- Task 3 was reworked mid-execution (2026-07-15): the first attempt implemented the pre-redesign `Promise.all` mechanism, was found Critical by task review, reverted, and redesigned via `superpowers:brainstorming` + a Fable-reviewed spec amendment (PR #49, merged) before being redone against the version documented in this plan. See Task 3's own note.
- `npm run eval -- --decompose` spends real money (~a cent) and needs `.env.local`'s `ANTHROPIC_API_KEY` — it is already present; do not echo or commit it. Task 5 now runs it twice as both the nondeterminism check AND the soft-deadline miss-rate measurement (spec §10.4) — no extra paid runs needed beyond what was already planned.
