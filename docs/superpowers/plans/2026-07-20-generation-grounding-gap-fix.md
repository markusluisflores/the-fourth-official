# Generation Grounding Gap Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #65 so the model reliably hedges instead of asserting
unsupported rulings when retrieved passages are topically relevant but
scenario-mismatched, and add generation-level verification that didn't
exist before (the eval suite currently tests retrieval recall only).

**Architecture:** Set `temperature: 0` on the answer-generation call and
harden the system prompt's grounding instruction. Add a new generation
harness (`evals/generation-harness.ts`) that runs real retrieval +
real generation for a question and reports which sources actually got
cited. Wire that into a new opt-in `--generation` mode in
`evals/run-evals.ts`: an automated completeness check (does the generated
answer cite every required source) for golden/paraphrase/compound
questions, and a manual-review hedging check for a new
`evals/hedge-questions.json` set.

**Tech Stack:** TypeScript, `tsx` (eval script runner), Anthropic SDK
(`@anthropic-ai/sdk`), Vitest.

## Global Constraints

- Never call the generation model in the default (free, retrieval-only)
  `npm run eval` path — all generation-level checks live behind a new
  `--generation` flag, mirroring the existing `--decompose` opt-in
  pattern (paid, not part of the default run).
- `temperature: 0` at the answer-generation call site, per spec §4.2.1 —
  never a low-nonzero value.
- Never edit `lib/retrieval.ts`, `match_chunks`, or `RELEVANCE_THRESHOLD`
  — this is a generation-only fix (spec §3 non-goals).
- The hedge-set check is manual-review, not automated pass/fail — print
  full answer text for a human/agent to judge, per spec §4.2.5. Do not
  build keyword-matching or an LLM-judge for this.
- Full spec: `docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md`
  (approved — do not deviate from its approach without a plan revision on
  its own docs branch, per this project's spec/plan-revision rule).
- All shell commands in this plan are POSIX `sh` syntax — run via a
  Bash-style tool, not PowerShell, on this Windows machine.
- As of this plan's authoring (2026-07-20), `main` has 30 golden questions
  and 14 compound questions — PR #72 (issue #64's fix, which adds 2 more
  golden sentinels) had not yet merged. If PR #72 merges before this plan
  executes, the golden count will be 32; adjust expected counts in Task 6
  accordingly and note it in that task's report — do not treat a count
  mismatch as a plan bug without checking `main`'s state first.

---

### Task 1: `lib/answer.ts` — temperature control, prompt hardening, cited-breadcrumb helper

**Files:**
- Modify: `lib/answer.ts`
- Test: `tests/answer.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TEMPERATURE` (exported constant, `0`), `streamAnswer`'s 4th
  parameter `temperature: number = TEMPERATURE`, a new exported function
  `citedBreadcrumbs(chunks: RetrievedChunk[], citedDocumentIndexes: number[]): string[]`
  — both consumed by Task 2's harness — and a new exported function
  `warnIfTemperatureUnsafe(model: string): void`, called internally by
  `streamAnswer` only (not consumed by later tasks).

- [ ] **Step 1: Write the failing tests**

Add to `tests/answer.test.ts`, after the existing `documentBlocks` describe
block:

```ts
describe("citedBreadcrumbs", () => {
  it("maps cited document indexes back to their chunk breadcrumbs", () => {
    const chunks = [chunk(1, "Law 11 › 1. Offside position"), chunk(2, "Law 15 › 1. Procedure")];
    expect(citedBreadcrumbs(chunks, [1, 0])).toEqual([
      "Law 15 › 1. Procedure",
      "Law 11 › 1. Offside position",
    ]);
  });

  it("returns an empty array when nothing was cited", () => {
    expect(citedBreadcrumbs([chunk(1, "Law 11 › 1. Offside position")], [])).toEqual([]);
  });
});

describe("warnIfTemperatureUnsafe", () => {
  it("does not warn for a known temperature-safe model", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnIfTemperatureUnsafe("claude-haiku-4-5");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("warns for a model not on the known-safe allowlist", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnIfTemperatureUnsafe("claude-opus-9-hypothetical");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("claude-opus-9-hypothetical"));
    spy.mockRestore();
  });
});
```

Add to the end of the `streamAnswer` describe block (after the last
existing `it`, before its closing `});`):

```ts
  it("passes temperature 0 to the underlying API call by default", async () => {
    const stream = vi.fn(() => fakeStream([], "end_turn"));
    const client = { messages: { stream } } as unknown as Anthropic;
    await collect(streamAnswer("q", chunks, client));
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it("passes a temperature override through to the underlying API call", async () => {
    const stream = vi.fn(() => fakeStream([], "end_turn"));
    const client = { messages: { stream } } as unknown as Anthropic;
    await collect(streamAnswer("q", chunks, client, 1));
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ temperature: 1 }));
  });
```

Update the import line at the top of `tests/answer.test.ts`:

```ts
import {
  citedBreadcrumbs,
  documentBlocks,
  streamAnswer,
  warnIfTemperatureUnsafe,
  type AnswerEvent,
} from "../lib/answer";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/answer.test.ts`
Expected: FAIL — `citedBreadcrumbs` is not exported (does not exist yet),
and the two new `streamAnswer` tests fail because `temperature` is never
passed to `client.messages.stream()`.

- [ ] **Step 3: Implement**

In `lib/answer.ts`, add the `TEMPERATURE` constant right after the
existing `MAX_ANSWER_TOKENS` line (currently line 7), before
`SYSTEM_PROMPT`:

```ts
// Temperature 0: this app's entire premise is "answer strictly from
// retrieved passages, never invent" — there is no scenario where creative
// sampling variance in a rules-lookup answer is desirable. See
// docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md.
//
// RISK: the Anthropic SDK deprecates the `temperature` parameter for
// models released after Claude Opus 4.6 — this app's value of 0 (not 1.0)
// would be REJECTED with a loud 400, breaking answer generation entirely
// (no silent-coercion path for a non-1.0 value). Verified live against
// the current ANSWER_MODEL (claude-haiku-4-5) on 2026-07-20 — temperature
// 0 works today. See CLAUDE.md's ANTHROPIC_MODEL secrets entry before
// ever changing that env var — that doc note is the actual prevention
// (read before the change is made). warnIfTemperatureUnsafe() below is
// diagnostic, not preventive: it fires on the same request that already
// hits the breaking 400, so it only makes the resulting server log
// easier to find after the fact — it does not stop the outage.
export const TEMPERATURE = 0;

// Best-effort allowlist backstop for the risk above — a diagnostic aid,
// not a preventive one (see the comment on TEMPERATURE). Not an
// authoritative capability check (Anthropic doesn't expose one) — a
// false negative here only produces a loud server-log warning, never a
// thrown error, since an unmaintained allowlist shouldn't break the
// endpoint on its own.
const KNOWN_TEMPERATURE_SAFE_MODELS = ["claude-haiku-4-5"];

export function warnIfTemperatureUnsafe(model: string): void {
  if (!KNOWN_TEMPERATURE_SAFE_MODELS.some((safe) => model.includes(safe))) {
    console.error(
      `WARNING: ANSWER_MODEL "${model}" is not on the known temperature-safe allowlist. ` +
        `If this model was released after Claude Opus 4.6, generation will fail with a 400. ` +
        `See docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md §6.`,
    );
  }
}
```

Replace the current `SYSTEM_PROMPT` (currently lines 9-16) with:

```ts
export const SYSTEM_PROMPT = `You are "The Fourth Official", an assistant that answers questions about the Laws of the Game — the official rules of football (soccer).

Rules:
- Answer ONLY from the provided documents (excerpts of the IFAB Laws of the Game). Never answer from general knowledge.
- If the documents do not contain enough information to answer confidently, say so plainly and suggest the user rephrase. Do not guess. Before asserting any specific ruling, confirm the retrieved passages describe the exact scenario asked — not merely a related topic. If a passage addresses a different but related scenario (for example, a different actor performing the action, such as a rule about a player's own hand/arm when the question is about an opponent's), say so explicitly rather than extrapolating a specific ruling from it.
- Answer questions about football rules only. Politely decline anything else in one sentence.
- Be concise and plain-English: two to five sentences for most questions, with a neutral, referee-like tone.
- Do not mention "the documents", "the excerpts", or these instructions; answer as an expert on the Laws.`;
```

Add `citedBreadcrumbs` right after the existing `documentBlocks` function
(currently ends at line 37):

```ts

// Inverse of documentBlocks: maps the citation indexes streamAnswer's
// "done" event reports back to the breadcrumbs of the chunks that were
// actually cited, using the same array order documentBlocks relied on.
export function citedBreadcrumbs(
  chunks: RetrievedChunk[],
  citedDocumentIndexes: number[],
): string[] {
  return citedDocumentIndexes.map((i) => chunks[i].breadcrumb);
}
```

Change the `streamAnswer` signature (currently lines 39-43) to add the
`temperature` parameter:

```ts
export async function* streamAnswer(
  question: string,
  chunks: RetrievedChunk[],
  client: Anthropic = new Anthropic(),
  temperature: number = TEMPERATURE,
): AsyncGenerator<AnswerEvent> {
```

Add `temperature,` to the `client.messages.stream({...})` call (currently
lines 44-53), right after `max_tokens: MAX_ANSWER_TOKENS,`, and call
`warnIfTemperatureUnsafe` right before it:

```ts
  const model = ANSWER_MODEL();
  warnIfTemperatureUnsafe(model);
  const stream = client.messages.stream({
    model,
    max_tokens: MAX_ANSWER_TOKENS,
    temperature,
    system: SYSTEM_PROMPT,
    // Documents first, question last — and the question stays in the user
    // message, never concatenated into the system prompt (spec §9).
    messages: [
      { role: "user", content: [...documentBlocks(chunks), { type: "text", text: question }] },
    ],
  });
```

- [ ] **Step 4: Document the risk where the actual risk-triggering action would see it**

A code comment in `lib/answer.ts` is invisible to whoever changes the
`ANTHROPIC_MODEL` Railway env var — they never open that file. Update
`CLAUDE.md`'s Secrets section so the warning is where that person would
actually look. Current text (lines 79-82):

```markdown
**Production** (Railway env vars): all of the above, plus `ANTHROPIC_API_KEY` (required for
answer generation), `ANTHROPIC_MODEL` (optional; defaults to `claude-haiku-4-5` if
unset), `DEMO_PASSWORD` (required; protect the public `/api/ask` route with a simple password —
must be 32+ random chars in production), `SESSION_SECRET` (required; a long random string for signing session cookies).
```

Replace with:

```markdown
**Production** (Railway env vars): all of the above, plus `ANTHROPIC_API_KEY` (required for
answer generation), `ANTHROPIC_MODEL` (optional; defaults to `claude-haiku-4-5` if
unset — **before changing this to a newer model generation, re-verify that `temperature: 0`
in `lib/answer.ts` still works live; the Anthropic SDK deprecates `temperature` for models
released after Claude Opus 4.6 and rejects a non-1.0 value with a 400, which would break
answer generation entirely — see `docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md` §6**),
`DEMO_PASSWORD` (required; protect the public `/api/ask` route with a simple password —
must be 32+ random chars in production), `SESSION_SECRET` (required; a long random string for signing session cookies).
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/answer.test.ts`
Expected: PASS, all tests including the pre-existing ones (nothing about
the existing `documentBlocks` or `streamAnswer` behavior changed except
adding a 4th parameter with a default that preserves old call sites).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/answer.ts tests/answer.test.ts CLAUDE.md
git commit -m "feat: temperature control, hardened grounding prompt, citedBreadcrumbs (issue #65)"
```

---

### Task 2: `evals/generation-harness.ts` — real generation harness

**Files:**
- Create: `evals/voyage-retry.ts`
- Create: `evals/generation-harness.ts`
- Modify: `evals/run-evals.ts` (extract its existing retry wrapper to the
  new shared file — see Step 2)

**Interfaces:**
- Consumes: `searchChunks` (`lib/retrieval.ts`, existing),
  `citedBreadcrumbs`, `streamAnswer`, `TEMPERATURE` (Task 1,
  `lib/answer.ts`).
- Produces: `withVoyageRetry<T>(fn, maxAttempts?): Promise<T>` (moved from
  `run-evals.ts`, now shared), and
  `runGeneration(question, k?, temperature?): Promise<GenerationResult>`
  where `GenerationResult = { answerText: string; citedBreadcrumbs: string[] }`
  — consumed by Task 4's `run-evals.ts` changes.

**Why the retry wrapper has to move:** `run-evals.ts` already has
`withVoyageRetry` for exactly this reason — Voyage's free tier (no
payment method on file) is rate-limited to 3 requests/minute, and every
existing retrieval call in that file routes through it
(`searchWithRetry`). `generation-harness.ts` needs the same protection for
its own `searchChunks` call (Task 6's verification run makes 50+
sequential calls with no gaps otherwise), but it cannot import
`withVoyageRetry` directly from `run-evals.ts` — Task 4 makes
`run-evals.ts` import `runGeneration` from `generation-harness.ts`, and a
reverse import would create a circular dependency between the two files.
Extracting the wrapper to its own file breaks the cycle.

This harness is a thin composition of live-service calls (retrieval, then
generation) — not unit-tested itself, same precedent as
`scripts/ingest/index.ts` (an operational script verified by running it,
not by Vitest). Its own verification is Task 6's live run.
`withVoyageRetry` is moved, not rewritten, so no new tests are needed for
it either — its behavior is unchanged, only its location.

- [ ] **Step 1: Extract the shared retry wrapper**

Write `evals/voyage-retry.ts` — this is `run-evals.ts`'s existing
`sleep`/`withVoyageRetry` (currently lines 53-72), moved verbatim:

```ts
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Voyage's free tier (no payment method on file) is rate-limited to 3 requests/minute.
// Retry with backoff on 429s so eval runs survive the free-tier limit end to end.
export async function withVoyageRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
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
```

- [ ] **Step 2: Refactor `run-evals.ts` to import the shared wrapper**

Remove the `sleep` and `withVoyageRetry` definitions (currently lines
53-72) from `evals/run-evals.ts` entirely. Add an import for the moved
function instead, next to the existing imports at the top of the file:

```ts
import { withVoyageRetry } from "./voyage-retry";
```

The existing `searchWithRetry` (currently lines 74-75) stays in
`run-evals.ts` unchanged — it already just calls `withVoyageRetry`, which
now resolves to the imported function instead of the local one:

```ts
const searchWithRetry = (question: string, k: number) =>
  withVoyageRetry(() => searchChunks(question, k));
```

- [ ] **Step 3: Verify the refactor didn't change behavior**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run tests/evals.test.ts`
Expected: PASS — this refactor only relocates `withVoyageRetry`, it
doesn't change `matchesExpected`/`scoreQuestion`/`coverageScore`, so the
existing tests are unaffected. (`withVoyageRetry` itself was never unit
tested before this move and isn't now either — same precedent as other
live-service orchestration in this file.)

- [ ] **Step 4: Write `evals/generation-harness.ts`**

```ts
import { searchChunks } from "../lib/retrieval";
import { citedBreadcrumbs, streamAnswer, TEMPERATURE } from "../lib/answer";
import { withVoyageRetry } from "./voyage-retry";

export interface GenerationResult {
  answerText: string;
  citedBreadcrumbs: string[];
}

// Runs the REAL generation step (not just retrieval) for one question.
// Used by run-evals.ts's --generation mode to check what a generated
// answer actually cites and says, not just what retrieval surfaced.
// Costs one real Anthropic call per invocation — unlike the rest of the
// eval suite (Voyage-only, free). The retrieval half is wrapped in
// withVoyageRetry for the same free-tier rate-limit reason every other
// retrieval call in this eval suite is. See
// docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md §4.2.3.
export async function runGeneration(
  question: string,
  k = 8,
  temperature: number = TEMPERATURE,
): Promise<GenerationResult> {
  const { chunks } = await withVoyageRetry(() => searchChunks(question, k));
  let answerText = "";
  let citedDocumentIndexes: number[] = [];
  for await (const event of streamAnswer(question, chunks, undefined, temperature)) {
    if (event.type === "text") answerText += event.delta;
    if (event.type === "done") citedDocumentIndexes = event.citedDocumentIndexes;
  }
  return { answerText, citedBreadcrumbs: citedBreadcrumbs(chunks, citedDocumentIndexes) };
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add evals/voyage-retry.ts evals/generation-harness.ts evals/run-evals.ts
git commit -m "feat: add real-generation eval harness, extract shared Voyage retry wrapper (issue #65)"
```

---

### Task 3: `evals/compound-questions.json` — two new multi-citation entries

**Files:**
- Modify: `evals/compound-questions.json`

**Interfaces:** none — pure data file edit.

Both entries below were verified two ways on 2026-07-20: against the live
`chunks` table (Supabase project `moybkceeltzwnyiaasys`,
`corpus_version = '2025-26'` — the cited breadcrumbs exist and their
content supports the question as written) **and** against real
`searchChunks(question, 8)` output — both required breadcrumbs land in
the actual top-8 for both questions today. **This second check matters
and is easy to skip:** a breadcrumb can exist and genuinely support a
question in the DB while still not ranking in the top-8 for reasons
unrelated to this fix (embedding distance, corpus size) — which would
make Task 4's `runGenerationCompoundSet` (fixed `k=8`) report a
permanent, unrelated false MISS. Any future compound-questions.json entry
must be checked against real retrieval output, not just table content,
before being added.

- [ ] **Step 1: Add a comma to the current last entry**

The file's current last entry (line 71, no trailing comma since it's the
last array element):

```json
    "note": "Tests whether retrieval surfaces the simultaneous-offense precedence rule (Law 5) alongside the handball offense definition itself (Law 12) — a real professional refereeing dispute about which infringement 'wins' when two happen in the same passage of play. Harvested from a real disputed 2026-07-19 incident (see issue #64/#65 comments)."
  }
]
```

Add a comma after that closing `}`, then append the two new entries
below, before the closing `]`:

```json
    "note": "Tests whether retrieval surfaces the simultaneous-offense precedence rule (Law 5) alongside the handball offense definition itself (Law 12) — a real professional refereeing dispute about which infringement 'wins' when two happen in the same passage of play. Harvested from a real disputed 2026-07-19 incident (see issue #64/#65 comments)."
  },
  {
    "question": "If the referee allows play to continue under advantage for a foul that would have warranted a red card, does the player still get sent off once the advantage phase ends?",
    "required": ["Law 5 › 3", "Law 12 › 4"],
    "note": "Law 5 › 3's advantage clause (the referee's authority to let play continue) and Law 12 › 4's explicit statement that a caution/sending-off already earned is not cancelled by playing advantage are two separate sections a full answer needs. Added issue #65 (generation-grounding fix) as a new generation-completeness test case, verified against the live corpus 2026-07-20."
  },
  {
    "question": "If a player who is already on a yellow card receives a second caution later in the same match and is sent off, can their team substitute another player in to replace them?",
    "required": ["Law 3 › 6", "Law 12 › 4"],
    "note": "Law 12 › 4 lists 'receiving a second caution in the same match' as a sending-off offence; Law 3 › 6 separately states a player sent off after kick-off cannot be replaced. A full answer needs both. Added issue #65 (generation-grounding fix) as a new generation-completeness test case, verified against the live corpus 2026-07-20."
  }
]
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('evals/compound-questions.json','utf8')); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add evals/compound-questions.json
git commit -m "test: add 2 multi-citation compound questions for generation completeness (issue #65)"
```

---

### Task 4: `evals/run-evals.ts` — wire the `--generation` mode

**Files:**
- Modify: `evals/run-evals.ts`
- Test: `tests/evals.test.ts`

**Interfaces:**
- Consumes: `runGeneration` (Task 2, `evals/generation-harness.ts`),
  `TEMPERATURE` (Task 1, `lib/answer.ts`), `scoreQuestion` and
  `coverageScore` (existing, this file).
- Produces: `parseTemperatureArg(): number`, `parseRepeatArg(): number` —
  pure, exported for testing. `runGenerationGoldenSet`,
  `runGenerationCompoundSet`, and `runHedgeSet` are internal orchestration
  (not exported, not unit tested — same live-service precedent as
  `runGoldenSet`/`runCompoundSet` already in this file).

**Why two completeness functions, not one:** `Golden.expected: string[]`
and `CompoundQuestion.required: string[]` look like the same shape but
mean different things. `expected` is OR-semantics — `scoreQuestion`
already treats it as "any of these counts as a hit" (see
`evals.test.ts`'s "honours any of several expected sections" test).
`required` is AND-semantics — `coverageScore` treats it as "every one of
these must be present." Running golden/paraphrase questions through
`coverageScore` would silently misscore any future golden question
authored with legitimate OR-alternatives as an incomplete answer even
when the model correctly cited one of them. Reusing `scoreQuestion` for
golden/paraphrase (mirroring how `runGoldenSet` already scores their
retrieval) and `coverageScore` only for compound questions (which are
inherently AND/multi-citation by design) keeps each check's semantics
correct.

- [ ] **Step 1: Write the failing tests for the two pure argv parsers**

Update the existing import line at the top of `tests/evals.test.ts`
(currently `import { coverageScore, matchesExpected, scoreQuestion } from "../evals/run-evals";`)
to add the two new names to the same import — do not add a second,
separate import line from the same module:

```ts
import {
  coverageScore,
  matchesExpected,
  parseRepeatArg,
  parseTemperatureArg,
  scoreQuestion,
} from "../evals/run-evals";
```

Add to `tests/evals.test.ts`:

```ts
describe("parseTemperatureArg", () => {
  it("defaults to TEMPERATURE (0) when --temperature is absent", () => {
    expect(parseTemperatureArg(["node", "run-evals.ts", "--generation"])).toBe(0);
  });

  it("parses an explicit --temperature=N value", () => {
    expect(parseTemperatureArg(["node", "run-evals.ts", "--generation", "--temperature=1"])).toBe(
      1,
    );
  });
});

describe("parseRepeatArg", () => {
  it("defaults to 1 when --repeat is absent", () => {
    expect(parseRepeatArg(["node", "run-evals.ts"])).toBe(1);
  });

  it("parses an explicit --repeat=N value", () => {
    expect(parseRepeatArg(["node", "run-evals.ts", "--repeat=5"])).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/evals.test.ts`
Expected: FAIL — `parseTemperatureArg` and `parseRepeatArg` are not
exported (do not exist yet).

- [ ] **Step 3: Implement**

Add the import for the new harness and `TEMPERATURE`, and a
`HedgeQuestion` interface, near the top of `evals/run-evals.ts` (after the
existing imports and before the `Golden` interface):

```ts
import { runGeneration } from "./generation-harness";
import { TEMPERATURE } from "../lib/answer";

interface HedgeQuestion {
  question: string;
  note?: string;
}
```

Add the two pure argv-parsing functions, taking `argv` as a parameter
(not reading `process.argv` directly, so they're testable) — place them
near the top-level helper functions, after `matchesExpected`/`scoreQuestion`/`coverageScore`:

```ts
export function parseTemperatureArg(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--temperature="));
  return arg ? Number(arg.split("=")[1]) : TEMPERATURE;
}

export function parseRepeatArg(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--repeat="));
  return arg ? Number(arg.split("=")[1]) : 1;
}
```

Add the two orchestration functions, after the existing
`runCompoundSetDecomposed` function and before `async function main()`:

```ts
// OR-semantics (mirrors runGoldenSet's retrieval-side scoring): a hit is
// citing ANY of the expected breadcrumbs, not all of them.
async function runGenerationGoldenSet(
  label: string,
  questions: Golden[],
  temperature: number,
): Promise<void> {
  let hits = 0;
  for (const g of questions) {
    const { citedBreadcrumbs } = await runGeneration(g.question, 8, temperature);
    const rank = scoreQuestion(
      citedBreadcrumbs.map((breadcrumb) => ({ breadcrumb })),
      g.expected,
    );
    if (rank > 0) hits += 1;
    console.log(`${rank > 0 ? `CITED@${rank}` : "NOT CITED"}  ${g.question}`);
  }
  console.log(
    `\n[${label} — generation completeness, temperature=${temperature}] cited: ${hits}/${questions.length}`,
  );
}

// AND-semantics (mirrors runCompoundSet's retrieval-side scoring): every
// required breadcrumb must be cited, not just one of them.
async function runGenerationCompoundSet(
  compounds: CompoundQuestion[],
  temperature: number,
): Promise<void> {
  let full = 0;
  for (const c of compounds) {
    const { citedBreadcrumbs } = await runGeneration(c.question, 8, temperature);
    const { missed } = coverageScore(
      citedBreadcrumbs.map((breadcrumb) => ({ breadcrumb })),
      c.required,
    );
    if (missed.length === 0) full += 1;
    console.log(
      `${missed.length === 0 ? "FULL " : "MISS "} ${c.required.length - missed.length}/${c.required.length}  ${c.question}`,
    );
    if (missed.length > 0) console.log(`  not cited in answer: ${missed.join(" | ")}`);
  }
  console.log(
    `\n[compound — generation completeness, temperature=${temperature}] full: ${full}/${compounds.length}`,
  );
}

async function runHedgeSet(
  hedges: HedgeQuestion[],
  temperature: number,
  repeat: number,
): Promise<void> {
  for (const h of hedges) {
    console.log(`\n--- ${h.question}`);
    if (h.note) console.log(`  (${h.note})`);
    for (let i = 1; i <= repeat; i++) {
      const { answerText } = await runGeneration(h.question, 8, temperature);
      console.log(`  run ${i}/${repeat}: ${answerText}`);
    }
  }
  console.log(
    `\n[hedge set] ${hedges.length} question(s) x ${repeat} run(s) at temperature=${temperature} — ` +
      `MANUALLY REVIEW each answer above: did it hedge (pass) or assert an unsupported specific ruling (fail)?`,
  );
}
```

Add the new mode dispatch in `main()`, right after the existing
`--decompose` block (before the line `const goldens: Golden[] = ...`):

```ts
  if (process.argv.includes("--generation")) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("--generation requires ANTHROPIC_API_KEY (it calls the real answer model)");
    }
    const temperature = parseTemperatureArg(process.argv);
    const repeat = parseRepeatArg(process.argv);
    const goldens: Golden[] = JSON.parse(await readFile("evals/golden-questions.json", "utf8"));
    const paraphrases: Golden[] = JSON.parse(
      await readFile("evals/paraphrase-questions.json", "utf8"),
    );
    const compounds: CompoundQuestion[] = JSON.parse(
      await readFile("evals/compound-questions.json", "utf8"),
    );
    const hedges: HedgeQuestion[] = JSON.parse(
      await readFile("evals/hedge-questions.json", "utf8"),
    );

    console.log(
      `=== Generation-level checks (temperature=${temperature}; calls the real Anthropic model — not free) ===`,
    );
    console.log("\n=== Golden set — generation completeness (OR-semantics) ===");
    await runGenerationGoldenSet("golden", goldens, temperature);

    console.log("\n=== Paraphrase set — generation completeness (OR-semantics) ===");
    await runGenerationGoldenSet("paraphrase", paraphrases, temperature);

    console.log("\n=== Compound set — generation completeness (AND-semantics) ===");
    await runGenerationCompoundSet(compounds, temperature);

    console.log("\n=== Hedge set — MANUAL REVIEW REQUIRED (not automated pass/fail) ===");
    await runHedgeSet(hedges, temperature, repeat);
    return;
  }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/evals.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (This will fail until Task 5 creates
`evals/hedge-questions.json` if you try to run the script — but `tsc`
only checks types, not file existence at runtime, so it passes once the
code compiles.)

- [ ] **Step 6: Commit**

```bash
git add evals/run-evals.ts tests/evals.test.ts
git commit -m "feat: add --generation mode to eval harness (completeness + hedge checks, issue #65)"
```

---

### Task 5: `evals/hedge-questions.json` — scenario-mismatch question set

**Files:**
- Create: `evals/hedge-questions.json`

**Interfaces:** none — pure data file, consumed by Task 4's `runHedgeSet`.

- [ ] **Step 1: Write the file**

Investigation completed during this plan's authoring (2026-07-20,
resolved a review NIT that originally deferred this to implementation
time — same effort either way, so it was finished here instead). Four
candidates were checked via real `searchChunks(question, 8)` output
against the live corpus, beyond the original reproduction question:

- *"If the ball deflects off a defender and falls to an attacking player
  in an offside position, does that cancel the offside?"* — **dead end**,
  `Law 11 › 2` already explicitly distinguishes deflection/rebound from
  deliberate play.
- *"If a player throws the ball into their own goal directly from a
  throw-in, does the goal count?"* — **dead end**, `Law 15 › Introduction`
  already explicitly states "if the ball enters the thrower's goal – a
  corner kick is awarded."
- *"If the ball touches a defender's arm and goes out for a corner kick
  instead of resulting in a goal, is that still a handball offence even
  though no goal was scored?"* — **dead end**, `Law 12 › 1`'s general
  handball offence list ("deliberately touches the ball with their
  hand/arm...") applies regardless of whether a goal resulted; confirmed
  as the top retrieval hit (similarity 0.611).
- *"If a goalkeeper's own hand or arm accidentally deflects the ball into
  their own team's goal, does that own goal count, or is it disallowed
  the same way a handball goal against the opponents would be?"* —
  **genuine hit.** `Law 12 › 1` has the highest raw similarity among the
  top-8 (0.667) — though it ranks 4th in the actual fused (hybrid
  vector+keyword) result order, behind three lower-similarity Law 12
  §2/3/4 chunks; doesn't affect the finding, since it's still safely
  inside the k=8 the harness uses. It explicitly covers a goalkeeper
  scoring *in the opponents' goal* off their own hand/arm ("scores in the
  opponents' goal: directly from their hand/arm, even if accidental,
  including by the goalkeeper") — but never addresses the reverse: a
  goalkeeper's hand/arm deflecting the ball into their *own* goal. Same
  shape as the original bug (a rule stated for one specific
  configuration, asked about a different one). Corrected 2026-07-20
  (independent fresh Fable review, PR #73) from an earlier, imprecise
  "top retrieval hit" claim that conflated similarity value with fused
  rank position.

Write `evals/hedge-questions.json`:

```json
[
  {
    "question": "If a player shoots a shot and it bounces off the arm of an opponent, but eventually gets a goal - Should the goal be disallowed and be considered a penalty or should the goal count?",
    "note": "Original issue #65 reproduction question. Retrieved Law 12 › 1 handball text governs a player's OWN hand/arm when scoring — it does not address an opponent's/defender's arm deflecting the ball into the goal. Correct behavior: hedge. Confirmed nondeterministic pre-fix (2026-07-19): one run hedged correctly, an identical retry asserted an unsupported ruling."
  },
  {
    "question": "If a goalkeeper's own hand or arm accidentally deflects the ball into their own team's goal, does that own goal count, or is it disallowed the same way a handball goal against the opponents would be?",
    "note": "New for issue #65's generation-grounding fix, verified 2026-07-20. Law 12 › 1 has the highest similarity among the top-8 (0.667, ranked 4th in the fused result order) and explicitly covers a goalkeeper scoring in the OPPONENTS' goal off their own hand/arm, but never addresses the reverse case of a deflection into their OWN goal. Correct behavior: hedge, not assert a specific ruling."
  }
]
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('evals/hedge-questions.json','utf8')); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 3: Confirm the working tree is otherwise clean**

Run: `git status --short`
Expected: only `evals/hedge-questions.json` (staged or modified) — no
stray `_tmp-*.ts` files (the investigation scripts used to check the four
candidates above were already run and deleted during this plan's
authoring).

- [ ] **Step 4: Commit**

```bash
git add evals/hedge-questions.json
git commit -m "test: add hedge-question set for generation-grounding checks (issue #65)"
```

---

### Task 6: Full verification run — completeness, hedging, temperature comparison

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md`
  (revision history table only)

**Interfaces:** none.

This task calls the real Anthropic API repeatedly (roughly 60-70 calls
across all sets combined at default repeat=1, more for the repeated-run
step below) — cheap per call on Haiku, but real cost, not free like the
rest of the eval suite.

- [ ] **Step 1: Run the completeness + single-pass hedge check at temperature 0**

Run: `npm run eval -- --generation`

Expected: golden and paraphrase sets show `cited: N/N` (every question's
single required breadcrumb was cited) or close to it — read the actual
output, don't assume. Compound set (16 questions after Task 3) shows
`full: N/N`; the two new Task 3 entries are the ones to check most
closely since they're unverified at the generation layer until now.
Hedge set prints one full answer per question for manual review — read
it and judge: did it hedge, or assert a specific unsupported ruling?

**If the golden/paraphrase completeness check shows unexpected misses**
(a single-citation question that used to work now not being cited): stop
and investigate before proceeding — this would mean temperature 0 or the
prompt change regressed something the fix wasn't supposed to touch.

**If the compound completeness check shows a regression** (a required
breadcrumb that Task 3 confirmed lands in the real top-8 retrieval is
still not being cited in the generated answer): stop and investigate
before proceeding, same as the golden/paraphrase gate above — per spec
§5, an unresolved compound regression is not shippable, this is a real
stop-gate, not just something to "check closely." Do not let this
verification step's own finding become a footnote carried forward
instead of resolved.

- [ ] **Step 2: Repeated-run hedge check at temperature 0**

Run: `npm run eval -- --generation --repeat=5`

Expected: both hedge questions each print 5 answers. Read all 5 for each
question — the fix is working if every run hedges
consistently. This is the direct test of the nondeterminism this issue
reports: the same question, run repeatedly, should no longer sometimes
hedge and sometimes assert a ruling.

**If any run asserts an unsupported specific ruling:** the fix is
incomplete. This is a plan/spec-level finding (temperature 0 alone
wasn't sufficient), not something to patch by re-running until it looks
better — stop and escalate per this project's rules on plan/spec-level
findings, rather than silently iterating.

- [ ] **Step 3: Temperature 1.0 comparison on the hedge set**

Run: `npm run eval -- --generation --temperature=1 --repeat=5`

Expected: for direct before/after comparison, record whether this run
(the pre-fix baseline temperature) shows more inconsistency across the 5
repeats than Step 2's temperature-0 run did.

- [ ] **Step 4: Record results in the spec's revision history**

Add a new row to the revision history table in
`docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md`,
with the actual measured results from Steps 1-3 (real numbers and a
real summary of the hedge-set manual review, not placeholder text):
golden/paraphrase/compound completeness rates at temperature 0, the
hedge set's consistency across 5 repeats at temperature 0 versus
temperature 1.0, and confirmation of whether Task 5's investigation found
additional genuine hedge questions or shipped with just the original one.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-20-generation-grounding-gap-design.md
git commit -m "docs: record post-fix generation-grounding verification results (issue #65)"
```

---

## Self-Review Notes

- **Spec coverage:** all of spec §4.2's pieces map to a task — temperature
  + prompt (Task 1), generation harness (Task 2), completeness-check test
  data (Task 3), completeness + hedge check wiring including the
  temperature-comparison flag from §4.2.7 (Task 4), hedge question set
  (Task 5), full verification + results recording (Task 6). The
  temperature-deprecation risk from spec §6 is addressed in Task 1 via a
  CLAUDE.md doc update plus a runtime allowlist warning, not just a code
  comment (see revision history — this was a real BLOCKER caught by
  review, not an original design choice).
- **No placeholders:** every step has literal code, exact file
  paths/line targets, exact commands, and exact expected output. Task 5's
  hedge-question investigation was completed during authoring (not
  deferred) — both dead ends and the one genuine additional gap found are
  documented with real, verified retrieval evidence.
- **Type consistency:** `citedBreadcrumbs`, `TEMPERATURE`,
  `warnIfTemperatureUnsafe`, and `streamAnswer`'s 4th `temperature`
  parameter (Task 1) are the exact names Task 2's `runGeneration` imports
  and uses. `withVoyageRetry` (Task 2, moved to `evals/voyage-retry.ts`)
  is the exact name both `run-evals.ts`'s existing `searchWithRetry` and
  `generation-harness.ts`'s `runGeneration` import. `GenerationResult`'s
  `citedBreadcrumbs` field (Task 2) is the exact name Task 4's
  `runGenerationGoldenSet` and `runGenerationCompoundSet` destructure.
  `HedgeQuestion` (Task 4) matches the exact shape Task 5's JSON file
  produces.

## Revision history

| Date | Change |
|---|---|
| 2026-07-20 | Initial plan. |
| 2026-07-20 | Fable review (PR #73, fresh dispatch): confirmed root-cause analysis, chosen fix, and all plan code/file-line references accurate against `main` and the live corpus — found 1 BLOCKER (the temperature-deprecation mitigation was a code comment in a file the actual risk-triggering action, a Railway `ANTHROPIC_MODEL` env var change, would never touch) and 3 SUGGESTIONs. Fixed: Task 1 now updates CLAUDE.md's `ANTHROPIC_MODEL` doc directly and adds a runtime `warnIfTemperatureUnsafe` allowlist check (with tests), replacing the comment-only mitigation; corrected the spec's inaccurate "silently coerced" claim (this app's `temperature: 0` only hits the loud-400 path, not silent coercion); Task 3 now documents that both new compound-questions.json entries were verified against real `searchChunks` output, not just DB content, and states this as a requirement for future entries; Task 5's previously-deferred hedge-question investigation was completed now instead (same effort, no reason to defer) — found one additional genuine gap (goalkeeper own-goal-via-handball) alongside a third confirmed dead end, so `evals/hedge-questions.json` now ships with 2 verified questions instead of 1. |
| 2026-07-20 | Resumed-thread verification: confirmed all 4 fixes above resolved (re-ran `searchChunks`, re-checked CLAUDE.md placement, re-traced code and tests by hand). **Independent fresh Fable review** (no prior context, told not to defer to earlier comments) on the resulting diff found a NEW BLOCKER neither prior round had caught: Task 2's `generation-harness.ts` called `searchChunks` directly, bypassing `run-evals.ts`'s existing `withVoyageRetry` backoff wrapper — live-confirmed this crashes with a Voyage 429 after 3 sequential calls, meaning Task 6's own mandated ~56-call verification run would abort partway through every time. Plus 3 SUGGESTIONs and 1 NIT. Fixed: extracted the shared retry wrapper to a new `evals/voyage-retry.ts` (avoiding a circular import between `generation-harness.ts` and `run-evals.ts`), refactored `run-evals.ts` to import it instead of defining it locally; split the single `runGenerationCompletenessSet` into `runGenerationGoldenSet` (OR-semantics, matching `Golden.expected`'s existing design) and `runGenerationCompoundSet` (AND-semantics, matching `CompoundQuestion.required`) — the original conflated both, which would have silently misscored any future golden question authored with legitimate OR-alternatives; clarified in both the spec and Task 1's code comments that `warnIfTemperatureUnsafe` is a diagnostic aid (makes the outage easier to find in logs) not a preventive one (the CLAUDE.md doc note is the actual prevention); corrected spec §5's stale "42 total" golden+paraphrase count to note it depends on whether PR #72 has merged; fixed an imprecise "top retrieval hit" claim for the goalkeeper hedge question (highest similarity, but ranked 4th in the actual fused top-8 — doesn't change the finding, just the wording). This is a third data point (after PR #69, #70, and this same PR #73's own first round) for the still-open fresh-vs-resumed review policy question: the resumed thread did real, additional verification work each time, but the independent fresh round again surfaced a materially different, non-overlapping, and this time more severe class of finding (a live-reproducible crash in the plan's own required verification step) than either the original or resumed rounds caught. |
| 2026-07-20 | **Third independent fresh Fable review** (no prior-thread context, told not to defer to earlier comments): live-verified every code line reference, traced the full data flow by hand (hedge/compound files through the harness to the Anthropic call), re-ran `searchChunks` against the live corpus for all 4 new/changed questions (including re-confirming the goalkeeper question's exact 0.667-similarity/4th-rank detail down to the decimal), grepped the installed SDK to re-confirm the temperature-deprecation quote, and independently re-triggered the same Voyage 429 the round-2 BLOCKER was about — as further live confirmation that fix was real, not just diff-level. **Found 0 BLOCKERs** — a genuinely clean pass after two real BLOCKERs in the two prior rounds. Found 1 SUGGESTION (Task 6's explicit stop-gate covered golden/paraphrase regressions but not a compound-tier regression, despite spec §5 stating compound regressions are also not shippable — fixed by adding an equivalent explicit stop-gate for the compound check) and 1 NIT (a duplicate import statement in the Task 4 test edit — fixed by merging into the existing import). Also caught and fixed a stale-wording issue found independently while applying the SUGGESTION fix: Task 6 still described golden/paraphrase output as `full: N/N`, but the OR/AND semantics split from the prior round renamed that output to `cited: N/N` for golden/paraphrase specifically. This is a fourth data point for the fresh-vs-resumed policy question, and the first of the three rounds on this PR where a fully independent read came back BLOCKER-free — some signal that the document has genuinely converged, not just that this round got lucky, given how thorough the verification was. |
