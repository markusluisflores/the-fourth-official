# Query Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compound questions retrieve all the law sections a complete answer needs, by splitting them into sub-questions with a parallel Haiku call, retrieving per sub-question, and merging — with zero behavior change for simple questions.

**Architecture:** The `/api/ask` route fires the decompose call and today's baseline retrieval concurrently. A "simple" verdict (or any decomposer failure) uses the baseline result unchanged; a 2–4-way split embeds all sub-questions in one Voyage call, searches per sub-question in parallel, and merges by rank round-robin (dedupe by chunk id, cap 12). The gate and answer stages are untouched; the answering model sees only the original question. Spec: `docs/superpowers/specs/2026-07-15-query-decomposition-design.md`.

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

### Task 3: route wiring — parallel decompose + merge

**Files:**
- Modify: `app/api/ask/route.ts` (retrieval block currently at lines 95–113)
- Test: `tests/ask-route.test.ts` (extend)

**Interfaces:**
- Consumes: `decompose` (Task 1), `searchChunksBatch`, `mergeResults` (Task 2).
- Produces: no new exports — behavior only. Simple path must remain byte-for-byte today's flow.

- [ ] **Step 1: Extend the route test mocks**

In `tests/ask-route.test.ts`, the module mocks at the top (lines 6–21) must now also cover `decompose` and `searchChunksBatch`. Add beside the existing `const searchChunks = vi.fn();`:

```typescript
const searchChunksBatch = vi.fn();
const decompose = vi.fn();
```

Extend the existing `vi.mock("../lib/retrieval", ...)` factory's returned object with:

```typescript
  searchChunksBatch: (...args: unknown[]) => searchChunksBatch(...args),
```

(`mergeResults` stays REAL via the existing `importOriginal` spread — it is pure and worth exercising.) Add a new mock block beside the others:

```typescript
vi.mock("../lib/decompose", () => ({
  decompose: (...args: unknown[]) => decompose(...args),
}));
```

In the existing `beforeEach`, add a default so every pre-existing test runs the simple path unchanged:

```typescript
  decompose.mockResolvedValue(null);
```

- [ ] **Step 2: Write the failing tests**

Append to the `describe("POST /api/ask", ...)` block:

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
```

- [ ] **Step 3: Run to verify the new tests fail**

Run: `npm test -- tests/ask-route.test.ts`
Expected: the five new tests FAIL (route neither calls `decompose` nor merges); pre-existing tests still pass.

- [ ] **Step 4: Wire the route**

In `app/api/ask/route.ts`, add imports:

```typescript
import { decompose } from "@/lib/decompose";
import { isRelevant, mergeResults, searchChunks, searchChunksBatch } from "@/lib/retrieval";
```

Replace the retrieval block (currently lines 95–101, the `let retrieval; try { retrieval = await searchChunks(question, 8); } ...`) with:

```typescript
  // Parallel decompose-and-retrieve (spec §3): the decompose call races the
  // baseline retrieval, so simple questions pay no added latency. decompose()
  // never rejects — a Promise.all rejection here is the baseline retrieval,
  // which is fatal today too.
  let retrieval;
  let subQuestions: string[] | null = null;
  try {
    const [baseline, subs] = await Promise.all([searchChunks(question, 8), decompose(question)]);
    retrieval = baseline;
    subQuestions = subs;
  } catch (err) {
    console.error("retrieval failed", { question: question.slice(0, 80), err });
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }

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

- [ ] **Step 5: Run the route tests**

Run: `npm test -- tests/ask-route.test.ts`
Expected: PASS (all, old and new).

- [ ] **Step 6: Full verification including build**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green (`build` catches App Router-specific breakage).

- [ ] **Step 7: Commit**

```bash
git add app/api/ask/route.ts tests/ask-route.test.ts
git commit -m "feat: parallel decompose-and-merge in ask route"
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

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-query-decomposition-design.md` (revision history)
- Modify: `docs/project-reviewer.md` (compound-question / decomposition talking point)
- Modify: `README.md` (known-limitation line)

**Interfaces:**
- Consumes: everything above, complete and merged into the feature branch.
- Produces: recorded before/after numbers; the regression bar (spec §10) checked; docs updated.

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

- [ ] **Step 2: Run the measurement**

Run: `npm run eval -- --decompose`

Record from the summary block: baseline full coverage (expected 3/9), decomposed full coverage, both mean coverages, and the per-question line for the red-card question ("What happens if everyone on a team gets a red card?") including its sub-questions. Because the split is nondeterministic, run it twice; if the two runs' full-coverage counts differ, record both and flag it in the PR description.

- [ ] **Step 2b: Sample simple-question latency (PR #46 review SUGGESTION)**

The spec's Goal 2 claims simple questions pay "added wait ≈ 0," but the route's `Promise.all([searchChunks(...), decompose(...)])` actually waits for whichever call is slower — `decompose()`'s 3000ms SDK timeout does not reject early on a merely-slow (not hung) Haiku response. This was never measured. Before recording numbers, get a rough read on it:

Write a throwaway script (do not commit it) that, for ~10 single-topic questions from `evals/golden-questions.json`, times `await Promise.all([searchChunks(q, 8), decompose(q)])` directly (bypassing the route) and prints wall-clock ms per call. Report the rough p50/p95 added latency versus `searchChunks` alone. This spends a small amount beyond the eval's ~1 cent (10 more Haiku calls) — acceptable, already within Task 5's paid-step budget.

If p95 added latency is negligible (roughly sub-second), the "added wait ≈ 0" framing in the spec stands — note the measured number in the revision-history row below. If it is not negligible, soften the spec's Goal 2 wording to disclose the tail-latency exposure explicitly (same treatment as the Voyage-429 residual risk in §7/§12) rather than leaving the unqualified claim in place.

- [ ] **Step 3: Record the numbers in the spec's revision history**

Append a row to the revision-history table in `docs/superpowers/specs/2026-07-15-query-decomposition-design.md`:

```markdown
| 2026-MM-DD | Measured: compound full coverage N/9 → M/9 (mean 0.NN → 0.NN) with --decompose; red-card question X/4 → Y/4. Simple-question added latency: p50 ~Nms, p95 ~Nms. |
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

In `docs/project-reviewer.md`, find the compound-question section (`grep -n -i "compound" docs/project-reviewer.md`) and extend it with 3–5 sentences: the measured baseline justified decomposition over raising k (2/9 questions unfixable at k=24); the parallel architecture keeps simple questions at baseline latency; the fallback contract means the decomposer can never make the product worse; before/after numbers.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-07-15-query-decomposition-design.md docs/project-reviewer.md README.md
git commit -m "docs: record query-decomposition measurement + README update"
```

- [ ] **Step 7: HUMAN CHECKPOINT — end-to-end acceptance (blocking)**

Spec §10.3: after the branch deploys (post-merge, Railway), Markus asks the original red-card question in the live app and confirms the ruling says an abandoned match does NOT become a penalty shoot-out. This is a manual check (the password gate blocks agent click-testing). **Per the global workflow rule, this unfinished verification BLOCKS calling the feature done** — track it explicitly in the PR/handoff; do not let it slide into a footnote.

---

## Execution notes

- Tasks 1 and 2 are independent of each other; Task 3 needs both; Task 4 needs 1+2; Task 5 needs all.
- Per the global CLAUDE.md rule, every implementer subagent dispatch must state the working directory AND branch, and its prompt must require `cd C:\ClaudeProjects\the-fourth-official && pwd && git branch --show-current` as the literal first command, stopping as BLOCKED on any mismatch.
- Task 1's review battery additionally includes `/security-review` + the `security-reviewer` agent (spec §9).
- `npm run eval -- --decompose` spends real money (~a cent) and needs `.env.local`'s `ANTHROPIC_API_KEY` — it is already present; do not echo or commit it.
